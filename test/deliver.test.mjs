import test from 'node:test'
import { strict as assert } from 'node:assert'
import { buildApprovalMessage, buildUserMessage, deliverToAgent } from '../src/deliver.js'

const IMPROVEMENT = {
  basedOn: 'acme/dsh-alpha',
  basedOnName: 'dsh-alpha',
  basedOnUrl: 'https://github.com/acme/dsh-alpha',
  category: 'Workflow & Automation',
  title: 'dsh-prepush-guard',
  delta: '原版只记录事件哈希，我要把它做成推送前可复核的清单，命中就阻断',
  why: '你推送前强制跑三步检查，这件事目前只能靠人工记流程',
  gap: '原版只记录事件，不判断该不该放行',
  evidence: 'acme/dsh-alpha 只做了一半',
  effort: '1天',
  verified: true,
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
  // 钉住的是"生产者自有的 kind"，不是某个具体写法：DSH 的 v4 会话格式明确拒收
  // 裸的 `{ kind: 'plugin', plugin: … }`（报 "format v4 message requires a
  // producer-owned source kind"）。这条断言以前正好在**要求**那个退役形状，
  // 所以投递一直是"看起来成功、那一轮必然失败"。别改回 plugin 字段。
  assert.deepEqual(message.source, { kind: 'plugin:daily' })
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
  const text = buildApprovalMessage(IMPROVEMENT, { projectsRoot: 'D:\\Projects', templateRoot: 'D:\\Projects\\dsh-warden' })
  assert.ok(text.includes('[DAILY APPROVAL]'))
  assert.ok(text.includes('dsh-prepush-guard'))
  assert.ok(text.includes('推送前跑三步检查'))
  assert.ok(text.includes('绝对不要推送'))
  assert.ok(text.includes('gh repo create <你自己的项目名> --public --source . --push'))
  assert.ok(text.includes('node --test'))
  assert.ok(text.includes('D:\\Projects\\dsh-warden'))
  // The reframing that matters: this is an improvement ON someone else's work.
  assert.ok(text.includes('原版（别人已发布的）：acme/dsh-alpha'))
  assert.ok(text.includes('https://github.com/acme/dsh-alpha'))
  assert.ok(text.includes(IMPROVEMENT.delta))
})

// The user's rule, stated as a hard gate: an independent repository, never a
// fork. Without this the most natural "helpful" move is `gh repo fork`.
test('the contract forbids forking, cloning and lifting the original code', () => {
  const text = buildApprovalMessage(IMPROVEMENT, {})
  assert.ok(text.includes('独立实现，不要 fork'))
  assert.ok(text.includes('禁止 `gh repo fork`'))
  assert.ok(text.includes('禁止 clone 别人的仓库'))
  assert.ok(text.includes('禁止整段搬运别人的代码'))
  assert.ok(text.includes('建**你自己的**仓库'))
  // Borrowing an idea is fine; copying code is not, and the README must say so.
  assert.ok(text.includes('灵感来自哪个原仓库'))
  assert.ok(text.includes('保留原版权声明'))
})

test('the contract restates the approved delta, why and gap verbatim', () => {
  const text = buildApprovalMessage(IMPROVEMENT, {})
  assert.ok(text.includes('具体改什么：' + IMPROVEMENT.delta))
  assert.ok(text.includes('为什么值得做：' + IMPROVEMENT.why))
  assert.ok(text.includes('原版的缺口：' + IMPROVEMENT.gap))
  assert.ok(text.includes('证据：' + IMPROVEMENT.evidence))
  assert.ok(!text.includes('参考对象'), 'the old copy-this framing is gone')
})

test('a missing source URL does not leak undefined into the contract', () => {
  const text = buildApprovalMessage(Object.assign({}, IMPROVEMENT, { basedOnUrl: '' }), {})
  assert.ok(text.includes('原版（别人已发布的）：acme/dsh-alpha'))
  assert.ok(!text.includes('undefined'))
})

// From-scratch ideas are still wanted, and they carry the same hard gates —
// only the framing differs, because there is no original to differ from.
const IDEA = {
  kind: 'idea',
  title: 'dsh-queue',
  oneLiner: '把日报变成可执行的开发队列',
  gap: '生态里没有把选品和开发连起来的插件',
  evidence: '无直接证据',
  effort: '1天',
}

test('an idea approval is framed as a new direction and keeps every hard gate', () => {
  const text = buildApprovalMessage(IDEA, { projectsRoot: 'D:\\Projects' })
  assert.ok(text.includes('[DAILY APPROVAL]'))
  assert.ok(text.includes('## 已批准的方向'))
  assert.ok(text.includes('dsh-queue'))
  assert.ok(text.includes('为什么生态里缺：' + IDEA.gap))
  // Same gates as an improvement: independent repo, tests, three-step check.
  assert.ok(text.includes('独立实现，不要 fork'))
  assert.ok(text.includes('gh repo create <你自己的项目名> --public --source . --push'))
  assert.ok(text.includes('绝对不要推送'))
  assert.ok(text.includes('node --test'))
  // No source repo, so no rename rule and no source-crediting rule.
  assert.ok(!text.includes('原版（别人已发布的）'))
  assert.ok(!text.includes('改名重发'))
})

test('an idea with no evidence says so rather than faking a finding', () => {
  const text = buildApprovalMessage(IDEA, {})
  assert.ok(text.includes('证据：无直接证据'))
  assert.ok(text.includes('不许把日报里标为「无直接证据」的推测写成已核实的事实'))
})

test('buildUserMessage produces the harness message shape', () => {
  const message = buildUserMessage('body', 'daily', 'id-1')
  assert.deepEqual(message, {
    id: 'id-1',
    role: 'user',
    content: [{ type: 'text', text: 'body' }],
    // 生产者自有的 kind（见上面那条断言的说明）：裸的 plugin 字段会被 v4 拒收。
    source: { kind: 'plugin:daily' },
  })
})
