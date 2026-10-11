// Integration tests: a stub Context drives the real apply(), so these exercise
// the actual scheduling, pool filtering, model validation, persistence and
// approval hand-off rather than a reimplementation of them.

import test from 'node:test'
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../src/host.js'
import { dayKey } from '../src/schedule.js'

const CSV = [
  '"category","name","repo","url","desc"',
  '"Workflow & Automation","dsh-alpha","acme/dsh-alpha","https://github.com/acme/dsh-alpha","Alpha automation"',
  '"Workflow & Automation","dsh-beta","acme/dsh-beta","https://github.com/acme/dsh-beta","Beta automation"',
  '"Security & Permissions","dsh-gamma","acme/dsh-gamma","https://github.com/acme/dsh-gamma","Gamma guard"',
  '"Just for Fun","dsh-delta","acme/dsh-delta","https://github.com/acme/dsh-delta","Delta fun"',
].join('\n')

const GOOD_WHY = '你推送前强制跑三步检查，这件事目前只能靠人工记流程'
const GOOD_DELTA = '原版只记录事件哈希，我要把它做成推送前可复核的清单，命中就阻断'

function improvement(basedOn, over) {
  return Object.assign({
    basedOn: basedOn,
    title: 'dsh-prepush-guard',
    type: '工具',
    delta: GOOD_DELTA,
    why: GOOD_WHY,
    gap: '原版只记录事件，不判断该不该放行',
    evidence: 'acme/dsh-alpha 只做了一半',
    effort: '1天',
  }, over || {})
}

function goodReply() {
  return JSON.stringify({
    improvements: [
      improvement('acme/dsh-alpha'),
      // In the corpus but justified with pure praise: dropped as boilerplate.
      improvement('acme/dsh-beta', { title: 'dsh-beta-guard', why: '很强大，值得一试' }),
      // Not in the corpus at all: dropped as a hallucination. Its hollow why is
      // never inspected, so this one must NOT also bump the boilerplate count.
      improvement('evil/hallucinated', { title: 'dsh-evil-guard', why: '这个插件很强大，值得一试' }),
    ],
    ideas: [
      { title: 'dsh-queue', type: '传播', oneLiner: '把日报变成可执行的开发队列', gap: 'acme/dsh-alpha 只做了一半', evidence: 'acme/dsh-alpha', effort: '1天' },
    ],
    notes: '今天四条候选，一条够格。',
  })
}

function fakeReq(method, url, body) {
  const handlers = {}
  const req = { method: method, url: url }
  req.on = function (eventName, cb) {
    handlers[eventName] = cb
    return req
  }
  req.destroy = function () {}
  setImmediate(function () {
    if (body !== undefined && handlers.data) handlers.data(JSON.stringify(body))
    if (handlers.end) handlers.end()
  })
  return req
}

function fakeRes() {
  let resolve
  const done = new Promise(function (r) { resolve = r })
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader: function (key, value) { res.headers[key] = value },
    end: function (chunk) {
      res.body = chunk === undefined ? undefined : JSON.parse(chunk)
      resolve()
    },
  }
  return { res: res, done: done }
}

function setup(options) {
  const opts = options || {}
  const home = mkdtempSync(join(tmpdir(), 'dsh-daily-host-'))
  const dataDir = join(home, 'daily')
  mkdirSync(dataDir, { recursive: true })
  const corpusPath = join(dataDir, 'corpus.csv')
  writeFileSync(corpusPath, CSV)

  mkdirSync(join(home, 'memories'), { recursive: true })
  writeFileSync(join(home, 'memories', 'memory_summary.md'), '用户喜欢自动化与安全审查')
  writeFileSync(join(home, 'AGENTS.md'), '先选路径再动手')
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(
    join(home, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-already-installed': 'link:x' } }),
  )

  const routes = []
  const effects = []
  const listeners = []
  const timers = []
  const cleared = []
  const prompts = []
  const followups = []
  let seq = 0

  // Mutable so a test can change the world mid-run, e.g. make a root agent
  // appear after an approval was queued with none.
  const flags = { noAgent: opts.noAgent === true, registerThrows: opts.registerThrows === true }

  const webServer = {
    register: function (spec) {
      if (flags.registerThrows) throw new Error('register failed')
      routes.push(spec)
      return function () { spec.disposed = true }
    },
  }

  const llm = {
    stream: function (options) {
      prompts.push(options)
      // `replies` scripts one reply per call, which is what the retry path needs.
      const queued = Array.isArray(opts.replies) ? opts.replies[prompts.length - 1] : undefined
      const reply = queued === undefined ? (opts.reply === undefined ? goodReply() : opts.reply) : queued
      return (async function* () {
        if (opts.finishError) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'model exploded' } } }
          return
        }
        if (opts.finishLength) {
          yield { type: 'text-delta', text: '{"improvements":[' }
          yield { type: 'finish', reason: { kind: 'length' } }
          return
        }
        yield { type: 'text-delta', text: reply }
        // `finishKinds` scripts the terminating reason per call, which is what
        // the truncation path needs: the text arrives, but the budget ran out.
        const kinds = Array.isArray(opts.finishKinds) ? opts.finishKinds : []
        const kind = kinds[prompts.length - 1]
        yield { type: 'finish', reason: { kind: kind === undefined ? 'stop' : kind } }
      })()
    },
  }

  const agent = {
    id: 'agent-1',
    runMaintenance: function (fn) {
      if (opts.agentBusy) throw new Error('agent busy')
      return Promise.resolve(fn())
    },
    followup: function (message) { followups.push(message) },
  }

  const services = {
    llm: opts.noLlm ? undefined : llm,
    agentDefaultModel: {
      currentSelection: function () { return { provider: 'test-provider', model: 'test-model', reasoningEffort: 'medium' } },
    },
    agents: { roots: function () { return flags.noAgent ? [] : [agent] } },
  }

  const ctx = {
    logger: { warn: function () {}, info: function () {} },
    webServer: webServer,
    effect: function (fn) { const dispose = fn(); effects.push(dispose); return function () {} },
    on: function (eventName, fn) { listeners.push({ name: eventName, fn: fn }); return function () {} },
    get: function (serviceName) { return services[serviceName] },
    timeout: function (fn, ms) { seq = seq + 1; const id = seq; timers.push({ id: id, fn: fn, ms: ms }); return id },
    clearTimeout: function (id) { cleared.push(id) },
  }

  const config = Object.assign({
    dshHome: home,
    codexHome: home,
    dataDir: dataDir,
    corpusPath: corpusPath,
    maxCandidates: 10,
    maxImprovements: 5,
    maxIdeas: 2,
    seedCorpus: join(home, 'no-such-seed.csv'),
  }, opts.config)

  // Written before apply(), the way a real machine has it on disk.
  if (opts.localConfig !== undefined) {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(opts.localConfig))
  }
  if (opts.localConfigRaw !== undefined) {
    writeFileSync(join(dataDir, 'config.json'), opts.localConfigRaw)
  }

  apply(ctx, config)

  return {
    home: home, dataDir: dataDir, corpusPath: corpusPath, routes: routes, effects: effects,
    listeners: listeners, timers: timers, cleared: cleared, prompts: prompts, followups: followups,
    agent: agent, flags: flags,
  }
}

async function call(built, method, url, body) {
  assert.equal(built.routes.length, 1, 'exactly one route should be registered')
  const { res, done } = fakeRes()
  await built.routes[0].handler(fakeReq(method, url, body), res)
  await done
  return { status: res.statusCode, body: res.body }
}

async function waitFor(predicate, label) {
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > 4000) throw new Error('timed out waiting for ' + label)
    await new Promise(function (r) { setTimeout(r, 10) })
  }
}

async function runAndWait(built) {
  const started = await call(built, 'POST', '/dsh-daily/run', {})
  assert.equal(started.status, 202)
  await waitFor(async function () {
    const state = await call(built, 'GET', '/dsh-daily/state')
    return state.body.status.running === false ? true : false
  }, 'the daily run to finish')
}

function readReport(built) {
  const path = join(built.dataDir, 'reports', dayKey(new Date()) + '.json')
  assert.ok(existsSync(path), 'expected a report at ' + path)
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('the plugin declares the name and services the harness expects', () => {
  assert.equal(name, 'dsh-daily')
  assert.deepEqual(inject, ['timer', 'webServer'])
})

test('apply registers one route and arms a timer without throwing', () => {
  const built = setup()
  assert.equal(built.routes.length, 1)
  assert.equal(built.routes[0].path, '/dsh-daily')
  assert.ok(built.timers.length >= 1)
  assert.equal(typeof built.timers[0].fn, 'function')
})

test('a webServer that refuses to register does not abort apply', () => {
  assert.doesNotThrow(function () { setup({ registerThrows: true }) })
})

test('GET state reports config and status before any run', async () => {
  const built = setup()
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.status, 200)
  assert.equal(state.body.config.hour, 11)
  assert.equal(state.body.config.maxImprovements, 5)
  assert.equal(state.body.config.maxIdeas, 2)
  assert.equal(state.body.status.running, false)
  assert.equal(state.body.today, undefined)
})

test('a run writes a report whose improvements all anchor on corpus repos', async () => {
  const built = setup()
  await runAndWait(built)
  const report = readReport(built)

  assert.equal(report.improvements.length, 1, 'the hallucinated source must not survive')
  assert.equal(report.improvements[0].basedOn, 'acme/dsh-alpha')
  assert.equal(report.improvements[0].basedOnUrl, 'https://github.com/acme/dsh-alpha')
  assert.equal(report.improvements[0].title, 'dsh-prepush-guard')
  assert.equal(report.improvements[0].verified, true)
  assert.equal(report.dropped.hallucinated, 1)
  // Checks run in order, so a hallucinated source is counted once, as a
  // hallucination. The boilerplate count is exactly one — the in-pool item that
  // was praised instead of justified — which is what proves the two counters
  // are not double-counting the same entry.
  assert.equal(report.dropped.boilerplateWhy, 1)
  assert.equal(report.dropped.noWhy, 0)
  assert.equal(report.dropped.sameName, 0)
  assert.equal(report.ideas.length, 1)
  assert.equal(report.ideas[0].title, 'dsh-queue')
  assert.equal(report.ideas[0].verified, true)
  assert.equal(report.model, 'test-provider/test-model')
  assert.equal(report.corpus.total, 4)
  assert.equal(report.trigger, 'manual')
})

test('the pool excludes plugins the user already installed', async () => {
  const built = setup({
    config: { maxCandidates: 10 },
  })
  writeFileSync(built.corpusPath, CSV + '\n"Just for Fun","dsh-already-installed","acme/dsh-already-installed","https://github.com/acme/dsh-already-installed","Installed already"')
  await runAndWait(built)
  assert.ok(built.prompts.length >= 1)
  assert.ok(!built.prompts[0].messages[0].content[0].text.includes('acme/dsh-already-installed'))
})

test('a repo recommended once is not offered again the next time', async () => {
  const built = setup()
  await runAndWait(built)
  await runAndWait(built)
  assert.equal(built.prompts.length, 2)
  assert.ok(built.prompts[0].messages[0].content[0].text.includes('acme/dsh-alpha'))
  assert.ok(
    !built.prompts[1].messages[0].content[0].text.includes('acme/dsh-alpha'),
    'an already-recommended repo must drop out of the pool',
  )
  assert.ok(built.prompts[1].messages[0].content[0].text.includes('acme/dsh-beta'))
})

test('the model is called with the configured route and the editor system prompt', async () => {
  const built = setup()
  await runAndWait(built)
  const call0 = built.prompts[0]
  assert.equal(call0.provider, 'test-provider')
  assert.equal(call0.model, 'test-model')
  assert.equal(call0.reasoningEffort, 'medium')
  assert.ok(call0.system.includes('每日改进编辑'))
  assert.equal(call0.messages[0].source.plugin, 'daily')
})

test('an unreadable model route surfaces as lastError, not a crash', async () => {
  const built = setup({ noLlm: true })
  await runAndWait(built)
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.ok(state.body.status.lastError.includes('no-llm'))
  assert.equal(state.body.today, undefined)
  assert.equal(existsSync(join(built.dataDir, 'reports', dayKey(new Date()) + '.json')), false)
})

test('a terminating model error chunk surfaces as lastError', async () => {
  const built = setup({ finishError: true })
  await runAndWait(built)
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.ok(state.body.status.lastError.includes('model exploded'))
})

test('a reply that is not JSON yields an empty report rather than inventing one', async () => {
  const built = setup({ reply: '抱歉，我今天不想工作。' })
  await runAndWait(built)
  const report = readReport(built)
  assert.deepEqual(report.improvements, [])
  assert.deepEqual(report.ideas, [])
  assert.equal(report.parsed, false)
  // The reply must be kept and the failure surfaced: an empty report that reads
  // as "nothing good today" would hide a broken generation.
  assert.equal(report.reply.head, '抱歉，我今天不想工作。')
  assert.equal(report.reply.finish, 'stop')
  assert.equal(report.reply.attempts.length, 2, 'it must retry before giving up')
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.ok(state.body.status.lastError.includes('可解析的 JSON'))
})

test('a first reply that is not JSON is retried, and the retry is the one used', async () => {
  const built = setup({ replies: ['抱歉，我今天不想工作。', goodReply()] })
  await runAndWait(built)
  assert.equal(built.prompts.length, 2, 'the model must be asked a second time')
  assert.ok(built.prompts[1].messages[0].content[0].text.includes('再试一次'))
  const report = readReport(built)
  assert.equal(report.parsed, true)
  assert.equal(report.improvements.length, 1)
  assert.equal(report.improvements[0].basedOn, 'acme/dsh-alpha')
  assert.equal(report.reply.attempts.length, 2)
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.status.lastError, undefined, 'a recovered run must not report a failure')
})

test('a good first reply is not retried', async () => {
  const built = setup()
  await runAndWait(built)
  assert.equal(built.prompts.length, 1)
})

// The brief the model reads is drawn from engineering memory, so it drifts back
// to an all-tooling report. The prompt asks for range; these two pin down what
// happens when that is ignored.
function narrowReply() {
  return JSON.stringify({
    improvements: [improvement('acme/dsh-alpha', { type: '工具' })],
    ideas: [{ title: 'dsh-x', type: '工具', oneLiner: 'O', gap: 'G', evidence: 'acme/dsh-alpha' }],
  })
}

test('a report where every item is one type is retried with a diversity nudge', async () => {
  const built = setup({ replies: [narrowReply(), goodReply()] })
  await runAndWait(built)
  assert.equal(built.prompts.length, 2, 'a narrow report must be asked again')
  const second = built.prompts[1].messages[0].content[0].text
  assert.ok(second.includes('至少覆盖 3 种'))
  assert.ok(second.includes('德州扑克'), 'the nudge must say why range is expected')
  const report = readReport(built)
  assert.equal(report.monotone, false)
  assert.equal(report.reply.attempts.length, 2)
})

test('a second reply that is still narrow keeps its content instead of losing the day', async () => {
  const built = setup({ replies: [narrowReply(), narrowReply()] })
  await runAndWait(built)
  assert.equal(built.prompts.length, 2, 'only one retry is allowed')
  const report = readReport(built)
  // The first parseable answer is the floor: a retry for narrowness must never
  // turn a usable report into no report at all.
  assert.equal(report.monotone, true)
  assert.equal(report.improvements.length, 1)
  assert.equal(report.ideas.length, 1)
  assert.deepEqual(report.typeCounts, { 工具: 2 })
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.status.lastError, undefined, 'a narrow report is not a failure')
})

test('a report that omits type is accepted without burning a second call', async () => {
  const typeless = JSON.stringify({
    improvements: [improvement('acme/dsh-alpha', { type: undefined })],
    ideas: [{ title: 'dsh-x', oneLiner: 'O', gap: 'G', evidence: 'acme/dsh-alpha' }],
  })
  const built = setup({ replies: [typeless, goodReply()] })
  await runAndWait(built)
  assert.equal(built.prompts.length, 1, 'a missing field is not worth another model call')
  const report = readReport(built)
  assert.equal(report.monotone, false)
  assert.equal(report.improvements[0].type, '未标注')
})

test('a reply truncated by the token budget is a failure, not a quiet day', async () => {
  const built = setup({ finishLength: true })
  await runAndWait(built)
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.ok(state.body.status.lastError.includes('length'), 'got: ' + state.body.status.lastError)
  assert.equal(state.body.today.parsed, false)
  assert.equal(state.body.today.reply.finish, 'length')
  assert.equal(state.body.today.reply.chars, 17)
  // Nothing was recoverable, so the message has to name the one cause the user
  // can act on rather than leaving them with a bare failure.
  assert.ok(state.body.status.lastError.includes('maxTokens'), 'got: ' + state.body.status.lastError)
})

// The regression suite for a real failure: the model wrote several complete
// improvements, ran out of output budget on the last one, and the whole reply was
// thrown away — "0 条" next to an error message, with usable work in hand.
function truncatedGoodReply() {
  return [
    '{',
    '  "improvements": [',
    '    ' + JSON.stringify(improvement('acme/dsh-alpha')),
    ',',
    '    ' + JSON.stringify(improvement('acme/dsh-beta', { title: 'dsh-other', type: '外观' })),
    ',',
    '    {"basedOn":"acme/dsh-alpha","type":"工具","title":"dsh-unfinished","delta":"这条还没写完',
  ].join('\n')
}

test('a truncated reply keeps every item that finished instead of losing the day', async () => {
  const built = setup({
    replies: [truncatedGoodReply(), goodReply()],
    finishKinds: ['max-tokens', 'stop'],
  })
  await runAndWait(built)

  const report = readReport(built)
  assert.equal(report.truncated, false, 'the retry produced a complete reply, so this is the one used')
  assert.equal(report.parsed, true)
  assert.ok(report.improvements.length >= 1)

  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.status.lastError, undefined, 'a recovered run is not a failure')

  // The retry must ask for something that fits, not repeat the same request.
  assert.equal(built.prompts.length, 2)
  const second = built.prompts[1].messages[0].content[0].text
  assert.ok(second.includes('截断'), 'the retry names what went wrong')
  assert.ok(second.includes('最多 4 个'), 'the retry asks for fewer items: ' + second.slice(-400))
})

test('when the retry is worse, the salvaged first reply is what survives', async () => {
  const built = setup({
    replies: [truncatedGoodReply(), '{"improvements":[]}'],
    finishKinds: ['max-tokens', 'stop'],
  })
  await runAndWait(built)

  const report = readReport(built)
  assert.equal(report.salvaged, true)
  assert.equal(report.truncated, true)
  assert.equal(report.improvements.length, 2, 'the two finished items are kept')
  assert.equal(report.improvements[0].basedOn, 'acme/dsh-alpha')

  // Salvaged content is real, so the run is not reported as a failure — but the
  // truncation is recorded rather than hidden behind a full-looking report.
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.status.lastError, undefined)
  assert.equal(state.body.today.truncated, true)
})

test('a truncation that recovers nothing is still an honest failure', async () => {
  const built = setup({
    replies: ['{"improvements":[', '{"improvements":['],
    finishKinds: ['max-tokens', 'max-tokens'],
  })
  await runAndWait(built)
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.today.parsed, false)
  assert.equal(state.body.today.improvements.length, 0)
  assert.ok(state.body.status.lastError.includes('max-tokens'))
  assert.ok(state.body.status.lastError.includes('maxTokens'), 'and says what to do about it')
})

test('a complete reply is not retried and is not marked truncated', async () => {
  const built = setup()
  await runAndWait(built)
  assert.equal(built.prompts.length, 1)
  const report = readReport(built)
  assert.equal(report.truncated, false)
  assert.equal(report.salvaged, false)
})

test('the state echoes maxTokens, because it is the knob that fixes a truncation', async () => {
  const built = setup()
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.config.maxTokens, 16000)
})

test('an idea proposed once is fed back so it is not proposed again', async () => {
  const built = setup()
  await runAndWait(built)
  await runAndWait(built)
  const second = built.prompts[1].messages[0].content[0].text
  assert.ok(second.includes('这些方向你已经提过了'), 'past ideas must reach the prompt')
  assert.ok(second.includes('- dsh-queue'))
})

test('approving an idea hands over the new-direction contract', async () => {
  const built = setup()
  await runAndWait(built)
  const result = await call(built, 'POST', '/dsh-daily/approve', { title: 'dsh-queue' })
  assert.equal(result.status, 200)
  assert.equal(result.body.delivered, true)
  const text = built.followups[0].content[0].text
  assert.ok(text.includes('## 已批准的方向'))
  assert.ok(text.includes('dsh-queue'))
  // Same hard gates as an improvement.
  assert.ok(text.includes('独立实现，不要 fork'))
  assert.ok(text.includes('绝对不要推送'))
  assert.ok(!text.includes('原版（别人已发布的）'), 'an idea has no source repo to credit')
})

test('approving an unknown target is refused', async () => {
  const built = setup()
  await runAndWait(built)
  const result = await call(built, 'POST', '/dsh-daily/approve', { title: 'not-a-real-idea' })
  assert.equal(result.status, 404)
  assert.equal(result.body.error, 'unknown-approval-target')
})

test('approving an improvement hands it over with the hard gates attached', async () => {
  const built = setup()
  await runAndWait(built)
  const result = await call(built, 'POST', '/dsh-daily/approve', { title: 'dsh-prepush-guard' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.delivered, true)
  assert.equal(built.followups.length, 1)
  const text = built.followups[0].content[0].text
  assert.ok(text.includes('[DAILY APPROVAL]'))
  assert.ok(text.includes('dsh-prepush-guard'))
  assert.ok(text.includes('原版（别人已发布的）：acme/dsh-alpha'))
  assert.ok(text.includes('绝对不要推送'))
  // The rule this plugin exists to enforce now: an independent repository,
  // never a fork of the source it improves on.
  assert.ok(text.includes('独立实现，不要 fork'))
  assert.ok(text.includes('gh repo create <你自己的项目名> --public --source . --push'))
  assert.ok(text.includes('零依赖构建'))
})

test('approving by its source repo hands over the same contract', async () => {
  const built = setup()
  await runAndWait(built)
  const result = await call(built, 'POST', '/dsh-daily/approve', { basedOn: 'acme/dsh-alpha' })
  assert.equal(result.body.delivered, true)
  const text = built.followups[0].content[0].text
  assert.ok(text.includes('独立实现，不要 fork'))
  assert.ok(text.includes('原版（别人已发布的）：acme/dsh-alpha'))
})

test('an approval with no live session is recorded as undelivered instead of lost', async () => {
  const built = setup({ noAgent: true })
  await runAndWait(built)
  const result = await call(built, 'POST', '/dsh-daily/approve', { title: 'dsh-prepush-guard' })
  assert.equal(result.body.ok, true)
  assert.equal(result.body.delivered, false)
  assert.equal(result.body.reason, 'no-live-session')
  assert.equal(built.followups.length, 0)

  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.status.pending, 1)
  assert.equal(state.body.approvals[0].delivered, false)
})

test('a pending approval is retried when a root agent appears', async () => {
  const built = setup({ noAgent: true })
  await runAndWait(built)
  await call(built, 'POST', '/dsh-daily/approve', { title: 'dsh-prepush-guard' })

  const created = built.listeners.find(function (item) { return item.name === 'agent/created' })
  assert.ok(created !== undefined, 'must listen for agent/created to retry approvals')

  // A session appears, so the same approval can now be handed over.
  built.flags.noAgent = false
  created.fn()
  await waitFor(function () { return built.followups.length === 1 ? true : false }, 'the retry to deliver')

  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.status.pending, 0)
  assert.equal(state.body.approvals[0].delivered, true)
})

test('a busy agent leaves the approval queued', async () => {
  const built = setup({ agentBusy: true })
  await runAndWait(built)
  const result = await call(built, 'POST', '/dsh-daily/approve', { title: 'dsh-prepush-guard' })
  assert.equal(result.body.delivered, false)
  assert.equal(result.body.reason, 'busy')
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.status.pending, 1)
})

test('skipping a plugin removes it from future pools', async () => {
  const built = setup()
  const result = await call(built, 'POST', '/dsh-daily/skip', { repo: 'acme/dsh-beta' })
  assert.equal(result.body.ok, true)
  await runAndWait(built)
  assert.ok(!built.prompts[0].messages[0].content[0].text.includes('acme/dsh-beta'))
})

test('unknown methods and verbs are rejected cleanly', async () => {
  const built = setup()
  const unknown = await call(built, 'POST', '/dsh-daily/nonsense', {})
  assert.equal(unknown.status, 404)
  const wrongVerb = await call(built, 'DELETE', '/dsh-daily/state')
  assert.equal(wrongVerb.status, 405)
})

test('state survives a reload from disk', async () => {
  const built = setup()
  await runAndWait(built)
  const first = await call(built, 'GET', '/dsh-daily/state')

  // A fresh apply() over the same data directory, as after a harness restart.
  const reloaded = setup({ config: { dataDir: built.dataDir, corpusPath: built.corpusPath, dshHome: built.home, codexHome: built.home } })
  const second = await call(reloaded, 'GET', '/dsh-daily/state')
  assert.equal(second.body.status.seen, first.body.status.seen)
  assert.ok(second.body.today !== undefined, 'today s report should be re-read from disk')
  assert.ok(second.body.history.length >= 1)
})

test('per-machine settings live in config.json, outside the repository', async () => {
  // hour/minute are not passed explicitly here, so they can only come from the
  // file — which is exactly the path a real installation takes.
  const built = setup({ localConfig: { hour: 7, minute: 30 } })
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.config.hour, 7)
  assert.equal(state.body.config.minute, 30)
})

test('explicit config beats config.json', async () => {
  const built = setup({ localConfig: { hour: 7 }, config: { hour: 19 } })
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.body.config.hour, 19)
})

test('a corrupt config.json cannot stop the plugin from loading', async () => {
  const built = setup({ localConfigRaw: '{ this is not json' })
  const state = await call(built, 'GET', '/dsh-daily/state')
  assert.equal(state.status, 200)
  assert.equal(state.body.config.hour, 11)
})

test('the shipped defaults carry no machine-specific paths', () => {
  // The install path is a local value; leaking it into a public repo would both
  // expose this machine and make the plugin useless on any other one.
  const source = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('dsh-plugin-survey'), 'a corpus path leaked into the shipped defaults')
  assert.ok(!source.includes('dsh-warden'), 'a template path leaked into the shipped defaults')
})

test('with no local template configured the approval contract still describes the skeleton', async () => {
  const built = setup()
  await runAndWait(built)
  await call(built, 'POST', '/dsh-daily/approve', { title: 'dsh-prepush-guard' })
  const text = built.followups[0].content[0].text
  assert.ok(text.includes('零依赖构建'))
  assert.ok(text.includes('cordis.patch.yml'))
  assert.ok(!text.includes('dsh-warden'), 'must not point at a template that may not exist')
})

test('unloading disposes the timer and the route', async () => {
  const built = setup()
  assert.ok(built.timers.length >= 1)
  for (const dispose of built.effects) {
    if (typeof dispose === 'function') dispose()
  }
  assert.ok(built.cleared.length >= 1, 'timer handles must be cleared on unload')
  assert.equal(built.routes[0].disposed, true, 'the route must be disposed on unload')
})
