import test from 'node:test'
import { strict as assert } from 'node:assert'
import {
  EVIDENCE_UNVERIFIED,
  buildReportPrompt,
  parseReportJson,
  sameName,
  validateReport,
} from '../src/report.js'

const pool = [
  {
    category: 'Workflow & Automation',
    name: 'dsh-alpha',
    repo: 'acme/dsh-alpha',
    url: 'https://github.com/acme/dsh-alpha',
    desc: 'Alpha thing for automation',
  },
  {
    category: 'Security & Permissions',
    name: 'dsh-beta',
    repo: 'acme/dsh-beta',
    url: 'https://github.com/acme/dsh-beta',
    desc: 'Beta thing for permissions',
  },
]

// A well-formed improvement: anchored on a pool repo, with a concrete delta and
// a why that lands on this user. Each test overrides exactly one field so the
// rule under test is the only thing that can fail.
function imp(repo, over) {
  return Object.assign({
    basedOn: repo,
    title: 'dsh-prepush-guard',
    delta: '原版只记录事件哈希，我要把它做成推送前可复核的清单，命中就阻断',
    why: '你推送前强制跑三步检查，这件事目前只能靠人工记流程',
    gap: '原版只记录事件，不判断该不该放行',
    evidence: 'acme/dsh-alpha 只做了一半',
    effort: '1天',
  }, over || {})
}

test('an improvement anchored on a repo outside the pool is dropped as a hallucination', () => {
  const out = validateReport({ improvements: [imp('evil/not-real')] }, pool)
  assert.equal(out.report.improvements.length, 0)
  assert.equal(out.dropped.hallucinated, 1)
})

test('the source link and category come from the pool, never from the model', () => {
  const out = validateReport({
    improvements: [imp('acme/dsh-alpha', { basedOnUrl: 'https://evil.example/x', category: 'evil' })],
  }, pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.report.improvements[0].basedOnUrl, 'https://github.com/acme/dsh-alpha')
  assert.equal(out.report.improvements[0].category, 'Workflow & Automation')
  assert.equal(out.report.improvements[0].basedOn, 'acme/dsh-alpha')
  assert.equal(out.report.improvements[0].basedOnName, 'dsh-alpha')
})

test('source matching ignores case and surrounding whitespace', () => {
  const out = validateReport({ improvements: [imp('  ACME/DSH-Alpha ')] }, pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.report.improvements[0].basedOn, 'acme/dsh-alpha')
})

test('an improvement with no delta is dropped: the delta is the product', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { delta: '   ' })] }, pool)
  assert.equal(out.report.improvements.length, 0)
  assert.equal(out.dropped.noDelta, 1)
})

test('a delta that is only empty praise is dropped', () => {
  for (const delta of ['做得更好', '增强体验', '更加完善', '优化性能']) {
    const out = validateReport({ improvements: [imp('acme/dsh-alpha', { delta: delta })] }, pool)
    assert.equal(out.report.improvements.length, 0, delta + ' must not pass as an improvement')
    assert.equal(out.dropped.hollowDelta, 1)
  }
})

test('a concrete delta that happens to contain a hollow phrase survives', () => {
  const delta = '原版只有一个总开关，我要把「优化性能」拆成按工具分类的独立阈值，并让命中原因可追溯'
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { delta: delta })] }, pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.dropped.hollowDelta, 0)
})

test('an improvement with an empty why is dropped', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { why: '  ' })] }, pool)
  assert.equal(out.report.improvements.length, 0)
  assert.equal(out.dropped.noWhy, 1)
})

test('a why that is only praise is dropped as boilerplate', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { why: '很强大，值得一试' })] }, pool)
  assert.equal(out.report.improvements.length, 0)
  assert.equal(out.dropped.boilerplateWhy, 1)
})

// The user's explicit rule: improve other people's work by publishing an
// INDEPENDENT implementation, never by renaming their repository.
test('a title that is just the source repo name is dropped as a rename-and-republish', () => {
  for (const title of ['dsh-alpha', 'DSH Alpha', 'dsh_alpha', 'acme/dsh-alpha']) {
    const out = validateReport({ improvements: [imp('acme/dsh-alpha', { title: title })] }, pool)
    assert.equal(out.report.improvements.length, 0, title + ' is the source name')
    assert.equal(out.dropped.sameName, 1)
  }
})

test('a distinct title on the same source is kept', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { title: 'dsh-prepush-guard' })] }, pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.dropped.sameName, 0)
})

test('sameName compares names, not descriptions or paths', () => {
  assert.equal(sameName('dsh-alpha', pool[0]), true)
  assert.equal(sameName('acme/dsh-alpha', pool[0]), true)
  assert.equal(sameName('dsh-alpha-improved', pool[0]), false)
  assert.equal(sameName('dsh-prepush-guard', pool[0]), false)
})

test('the same source proposed twice is counted once', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha'), imp('acme/dsh-alpha')] }, pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.dropped.duplicate, 1)
})

test('improvements are capped at maxImprovements', () => {
  const many = []
  for (let i = 0; i < 20; i++) {
    many.push({ category: 'c', name: 'p' + i, repo: 'acme/p' + i, url: 'u', desc: 'd' })
  }
  // Distinct titles: two items the user cannot tell apart by name are dropped as
  // duplicates before the cap is ever reached.
  const list = many.map(function (entry, i) { return imp(entry.repo, { title: 'dsh-cap-' + i }) })
  const out = validateReport({ improvements: list }, many, { maxImprovements: 3 })
  assert.equal(out.report.improvements.length, 3)
  assert.equal(out.dropped.duplicate, 0)
})

test('an improvement missing a required field is dropped as malformed', () => {
  const out = validateReport({
    improvements: [
      imp('acme/dsh-alpha', { title: '' }),
      imp('acme/dsh-alpha', { gap: '  ' }),
      imp('acme/dsh-alpha', { evidence: '' }),
    ],
  }, pool)
  assert.equal(out.report.improvements.length, 0)
  assert.equal(out.dropped.malformed, 3)
})

test('evidence naming a pool repo marks the improvement verified', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { evidence: 'acme/dsh-beta 只做了权限，没做推送前检查' })] }, pool)
  assert.equal(out.report.improvements[0].verified, true)
})

test('evidence citing a link marks the improvement verified', () => {
  const out = validateReport({
    improvements: [imp('acme/dsh-alpha', { evidence: '见 https://github.com/acme/dsh-alpha 的 issue #3' })],
  }, pool)
  assert.equal(out.report.improvements[0].verified, true)
})

test('evidence explicitly admitting it has none is kept but marked unverified', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { evidence: EVIDENCE_UNVERIFIED })] }, pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.report.improvements[0].verified, false)
})

test('evidence that grounds nothing is downgraded rather than trusted', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { evidence: '我印象里好像没人做' })] }, pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.report.improvements[0].verified, false)
})

test('unusable input yields an empty report instead of throwing', () => {
  for (const value of [undefined, null, 42, 'text']) {
    const out = validateReport(value, pool)
    assert.equal(out.ok, false)
    assert.deepEqual(out.report.improvements, [])
    assert.deepEqual(out.report.ideas, [])
  }
  assert.equal(validateReport({}, undefined).report.improvements.length, 0)
})

test('an idea needs a title, one-liner, gap and evidence', () => {
  const out = validateReport({
    ideas: [
      { title: 'T', oneLiner: 'O', gap: 'G', evidence: EVIDENCE_UNVERIFIED },
      { title: '', oneLiner: 'O', gap: 'G', evidence: EVIDENCE_UNVERIFIED },
      { title: 'T', oneLiner: '', gap: 'G', evidence: EVIDENCE_UNVERIFIED },
      { title: 'T', oneLiner: 'O', gap: '', evidence: EVIDENCE_UNVERIFIED },
      { title: 'T', oneLiner: 'O', gap: 'G', evidence: '' },
    ],
  }, pool)
  assert.equal(out.report.ideas.length, 1)
  assert.equal(out.dropped.malformedIdea, 4)
})

test('an idea citing a pool repo is marked verified', () => {
  const out = validateReport({
    ideas: [{ title: 'dsh-new', oneLiner: 'O', gap: 'G', evidence: 'acme/dsh-alpha 只做了一半' }],
  }, pool)
  assert.equal(out.report.ideas[0].verified, true)
})

test('an idea admitting it has no evidence is kept but marked unverified', () => {
  const out = validateReport({
    ideas: [{ title: 'dsh-new', oneLiner: 'O', gap: 'G', evidence: EVIDENCE_UNVERIFIED }],
  }, pool)
  assert.equal(out.report.ideas.length, 1)
  assert.equal(out.report.ideas[0].verified, false)
})

test('the same idea title twice is counted once', () => {
  const idea = { title: 'dsh-new', oneLiner: 'O', gap: 'G', evidence: EVIDENCE_UNVERIFIED }
  const out = validateReport({ ideas: [idea, idea] }, pool)
  assert.equal(out.report.ideas.length, 1)
  assert.equal(out.dropped.duplicate, 1)
})

test('ideas are capped at maxIdeas', () => {
  const list = []
  for (let i = 0; i < 8; i++) {
    list.push({ title: 'dsh-new-' + i, oneLiner: 'O', gap: 'G', evidence: EVIDENCE_UNVERIFIED })
  }
  const out = validateReport({ ideas: list }, pool, { maxIdeas: 2 })
  assert.equal(out.report.ideas.length, 2)
})

test('improvements and ideas coexist in one reply', () => {
  const out = validateReport({
    improvements: [imp('acme/dsh-alpha')],
    ideas: [{ title: 'dsh-new', oneLiner: 'O', gap: 'G', evidence: EVIDENCE_UNVERIFIED }],
    notes: '两样都有',
  }, pool, { maxImprovements: 5, maxIdeas: 3 })
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.report.ideas.length, 1)
  assert.equal(out.report.notes, '两样都有')
})

test('a title reused across both lists is counted once', () => {
  // Improvements and ideas share one title namespace, so the second use of a
  // name is a duplicate rather than two items the user cannot tell apart.
  const out = validateReport({
    improvements: [imp('acme/dsh-alpha', { title: 'dsh-shared' })],
    ideas: [{ title: 'dsh-shared', oneLiner: 'O', gap: 'G', evidence: EVIDENCE_UNVERIFIED }],
  }, pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.report.ideas.length, 0)
  assert.equal(out.dropped.duplicate, 1)
})

test('parseReportJson tolerates code fences and surrounding prose', () => {
  assert.deepEqual(parseReportJson('```json\n{"improvements":[]}\n```'), { improvements: [] })
  assert.deepEqual(parseReportJson('好的，结果如下：{"improvements":[],"notes":"x"} 完毕'), { improvements: [], notes: 'x' })
  assert.deepEqual(parseReportJson('{"a":{"b":1}}'), { a: { b: 1 } })
})

test('parseReportJson returns undefined on unusable replies', () => {
  for (const value of ['', 'no json at all', '{broken', undefined, null]) {
    assert.equal(parseReportJson(value), undefined)
  }
})

test('the prompt asks for both improvements and ideas, not for a reading list', () => {
  const prompt = buildReportPrompt({
    date: '2026-10-08',
    brief: '## 这位用户是谁\n喜欢自动化',
    candidates: pool,
    maxImprovements: 7,
    maxIdeas: 2,
  })
  assert.ok(prompt.includes('最多 7 个'))
  assert.ok(prompt.includes('最多 2 个'))
  assert.ok(prompt.includes(EVIDENCE_UNVERIFIED))
  assert.ok(prompt.includes('acme/dsh-alpha'))
  assert.ok(prompt.includes('acme/dsh-beta'))
  assert.ok(prompt.includes('不许编造'))
  // The rules that define the product direction.
  assert.ok(prompt.includes('不是 fork'), 'the prompt must rule out forking')
  assert.ok(prompt.includes('不是改名重发'), 'the prompt must rule out renaming the source')
  assert.ok(prompt.includes('delta'), 'the prompt must demand a concrete delta')
  assert.ok(prompt.includes('"ideas"'), 'the prompt must still ask for from-scratch directions')
})

test('past idea titles are fed back so the same direction is not proposed twice', () => {
  const prompt = buildReportPrompt({
    date: '2026-10-09',
    brief: 'b',
    candidates: pool,
    pastIdeas: ['dsh-already-suggested', 'dsh-also-suggested'],
  })
  assert.ok(prompt.includes('这些方向你已经提过了，不要重复'))
  assert.ok(prompt.includes('- dsh-already-suggested'))
  assert.ok(prompt.includes('- dsh-also-suggested'))
})

test('no past-idea block appears when nothing has been proposed yet', () => {
  const prompt = buildReportPrompt({ date: '2026-10-09', brief: 'b', candidates: pool })
  assert.ok(!prompt.includes('这些方向你已经提过了'))
})
