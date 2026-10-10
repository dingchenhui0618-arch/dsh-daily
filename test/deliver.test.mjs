import test from 'node:test'
import { strict as assert } from 'node:assert'
import { buildApprovalMessage, buildUserMessage, deliverToAgent } from '../src/deliver.js'

const IDEA = {
  title: 'dsh-example',
  oneLiner: '把每日候选变成可执行的开发队列',
  gap: '生态里没有把选品和开发连起来的插件',
  evidence: '无直接证据',
  effort: '1天',
}

function agentStub(id, behaviour) {
  const calls = { maintenance: 0, followup: [] }
  const agent = {
    id: id,
    runMaintenance(fn) {
      calls.maintenance = calls.maintenance + 1
      if (behaviour === 'throws') throw new Error('agent busy')
      if (behaviour === 'rejects') return Promise.reject(new Error('agent busy'))
      // Never enters the maintenance body: claims but does not run.
      if (behaviour === 'silent') return Promise.resolve(false)
      return Promise.resolve(fn())
    },
    followup(message) {
      calls.followup.push(message)
    },
  }
  return { agent: agent, calls: calls }
}

test('no agents service is reported, not thrown', async () => {
  const outcome = await deliverToAgent(undefined, 'x')
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.reason, 'no-agents-service')
})

test('a broken agents service is reported', async () => {
  const outcome = await deliverToAgent({ roots: function () { throw new Error('nope') } }, 'x')
  assert.equal(outcome.delivered, false)
  assert.ok(outcome.reason.startsWith('roots-failed'))
})

test('with no live session the approval stays undelivered so it can be retried', async () => {
  const outcome = await deliverToAgent({ roots: function () { return [] } }, 'x')
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.reason, 'no-live-session')
})

test('a live idle agent receives the message as a user turn from this plugin', async () => {
  const stub = agentStub('agent-1', 'ok')
  const outcome = await deliverToAgent({ roots: function () { return [stub.agent] } }, 'hello', { plugin: 'daily' })
  assert.equal(outcome.delivered, true)
  assert.equal(outcome.agentId, 'agent-1')
  assert.equal(stub.calls.followup.length, 1)
  const message = stub.calls.followup[0]
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, 'hello')
  assert.deepEqual(message.source, { kind: 'plugin', plugin: 'daily' })
  assert.equal(typeof message.id, 'string')
})

test('a synchronously throwing runMaintenance counts as busy', async () => {
  const stub = agentStub('agent-1', 'throws')
  const outcome = await deliverToAgent({ roots: function () { return [stub.agent] } }, 'x')
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.reason, 'busy')
  assert.equal(stub.calls.followup.length, 0)
})

test('a rejecting runMaintenance counts as busy', async () => {
  const stub = agentStub('agent-1', 'rejects')
  const outcome = await deliverToAgent({ roots: function () { return [stub.agent] } }, 'x')
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.reason, 'busy')
})

test('a claim that never enters the maintenance body does not count as delivered', async () => {
  const stub = agentStub('agent-1', 'silent')
  const outcome = await deliverToAgent({ roots: function () { return [stub.agent] } }, 'x')
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.reason, 'maintenance-not-entered')
  assert.equal(stub.calls.followup.length, 0)
})

test('a busy first agent does not stop a second one from receiving it', async () => {
  const busy = agentStub('busy-1', 'throws')
  const idle = agentStub('idle-2', 'ok')
  const outcome = await deliverToAgent({ roots: function () { return [busy.agent, idle.agent] } }, 'x')
  assert.equal(outcome.delivered, true)
  assert.equal(outcome.agentId, 'idle-2')
  assert.equal(idle.calls.followup.length, 1)
})

test('an agent without the required API is skipped, not crashed on', async () => {
  const outcome = await deliverToAgent({ roots: function () { return [{ id: 'x' }] } }, 'x')
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.reason, 'agent-missing-api')
})

test('the approval message carries every hard gate', () => {
  const text = buildApprovalMessage(IDEA, { projectsRoot: 'D:\\Projects', templateRoot: 'D:\\Projects\\dsh-warden' })
  assert.ok(text.includes('[DAILY APPROVAL]'))
  assert.ok(text.includes('dsh-example'))
  assert.ok(text.includes('推送前跑三步检查'))
  assert.ok(text.includes('绝对不要推送'))
  assert.ok(text.includes('gh repo create --public --source . --push'))
  assert.ok(text.includes('node --test'))
  assert.ok(text.includes('D:\\Projects\\dsh-warden'))
})

test('a reference-mode approval is framed as build-your-own, not reimplement', () => {
  const text = buildApprovalMessage(Object.assign({ mode: 'reference' }, IDEA), {})
  assert.ok(text.includes('照这个做一个'))
  assert.ok(text.includes('参考对象（不是要复刻它）'))
  assert.ok(text.includes('不许换个名字'))
})

test('a build-mode approval uses the approved-direction framing', () => {
  const text = buildApprovalMessage(Object.assign({ mode: 'build' }, IDEA), {})
  assert.ok(text.includes('## 已批准的方向'))
  assert.ok(!text.includes('参考对象（不是要复刻它）'))
})

test('buildUserMessage produces the harness message shape', () => {
  const message = buildUserMessage('body', 'daily', 'id-1')
  assert.deepEqual(message, {
    id: 'id-1',
    role: 'user',
    content: [{ type: 'text', text: 'body' }],
    source: { kind: 'plugin', plugin: 'daily' },
  })
})
