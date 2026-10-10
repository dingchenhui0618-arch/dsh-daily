import test from 'node:test'
import { strict as assert } from 'node:assert'
import {
  IDEA_UNVERIFIED,
  buildReportPrompt,
  parseReportJson,
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

function pick(repo, why) {
  return { repo: repo, why: why }
}

test('a pick whose repo is not in the pool is dropped as a hallucination', () => {
  const out = validateReport({ picks: [pick('evil/not-real', '能帮你处理每天的插件调研工作')] }, pool)
  assert.equal(out.report.picks.length, 0)
  assert.equal(out.dropped.hallucinated, 1)
})

test('pick links come from the pool, never from the model', () => {
  const out = validateReport({ picks: [{ repo: 'acme/dsh-alpha', why: '能接上你现有的自动化流程，省掉手工翻生态的时间', url: 'https://evil.example/x' }] }, pool)
  assert.equal(out.report.picks.length, 1)
  assert.equal(out.report.picks[0].url, 'https://github.com/acme/dsh-alpha')
  assert.equal(out.report.picks[0].category, 'Workflow & Automation')
})

test('repo matching ignores case and surrounding whitespace', () => {
  const out = validateReport({ picks: [pick('  ACME/DSH-Alpha ', '能接上你现有的自动化流程，省掉手工翻生态的时间')] }, pool)
  assert.equal(out.report.picks.length, 1)
  assert.equal(out.report.picks[0].repo, 'acme/dsh-alpha')
})

test('a pick with an empty why is dropped', () => {
  const out = validateReport({ picks: [pick('acme/dsh-alpha', '   ')] }, pool)
  assert.equal(out.report.picks.length, 0)
  assert.equal(out.dropped.noWhy, 1)
})

test('a pick whose why is only praise is dropped as boilerplate', () => {
  const out = validateReport({ picks: [pick('acme/dsh-alpha', '很强大，值得一试')] }, pool)
  assert.equal(out.report.picks.length, 0)
  assert.equal(out.dropped.boilerplateWhy, 1)
})

test('a concrete why that happens to contain a praise word survives', () => {
  const why = '这个插件的钩子机制很强大，正好能接上你现有的审查流程，省掉每天手工翻生态的时间'
  const out = validateReport({ picks: [pick('acme/dsh-alpha', why)] }, pool)
  assert.equal(out.report.picks.length, 1)
  assert.equal(out.dropped.boilerplateWhy, 0)
})

test('the same repo picked twice is counted once', () => {
  const why = '能接上你现有的自动化流程，省掉手工翻生态的时间'
  const out = validateReport({ picks: [pick('acme/dsh-alpha', why), pick('acme/dsh-alpha', why)] }, pool)
  assert.equal(out.report.picks.length, 1)
  assert.equal(out.dropped.duplicate, 1)
})

test('picks are capped at maxRecommend', () => {
  const many = []
  for (let i = 0; i < 20; i++) {
    many.push({ category: 'c', name: 'p' + i, repo: 'acme/p' + i, url: 'u', desc: 'd' })
  }
  const picks = many.map(function (entry) { return pick(entry.repo, '能接上你现有的自动化流程，省掉手工翻生态的时间') })
  const out = validateReport({ picks: picks }, many, { maxRecommend: 3 })
  assert.equal(out.report.picks.length, 3)
})

test('an idea grounded in a pool repo is marked verified', () => {
  const out = validateReport({
    ideas: [{ title: 'T', oneLiner: 'O', gap: 'G', evidence: 'acme/dsh-alpha 只做了一半', effort: '半天' }],
  }, pool)
  assert.equal(out.report.ideas.length, 1)
  assert.equal(out.report.ideas[0].verified, true)
})

test('an idea citing a link is marked verified', () => {
  const out = validateReport({
    ideas: [{ title: 'T', oneLiner: 'O', gap: 'G', evidence: '见 https://github.com/acme/dsh-alpha 的 issue', effort: '1天' }],
  }, pool)
  assert.equal(out.report.ideas[0].verified, true)
})

test('an idea explicitly admitting it has no evidence is kept but marked unverified', () => {
  const out = validateReport({
    ideas: [{ title: 'T', oneLiner: 'O', gap: 'G', evidence: IDEA_UNVERIFIED, effort: '1天' }],
  }, pool)
  assert.equal(out.report.ideas.length, 1)
  assert.equal(out.report.ideas[0].verified, false)
})

test('evidence that grounds nothing is downgraded to unverified rather than trusted', () => {
  const out = validateReport({
    ideas: [{ title: 'T', oneLiner: 'O', gap: 'G', evidence: '我印象里生态里好像没人做', effort: '1天' }],
  }, pool)
  assert.equal(out.report.ideas.length, 1)
  assert.equal(out.report.ideas[0].verified, false)
})

test('an idea missing any required field is dropped', () => {
  const out = validateReport({
    ideas: [
      { title: 'T', oneLiner: 'O', gap: 'G' },
      { title: '', oneLiner: 'O', gap: 'G', evidence: IDEA_UNVERIFIED },
      { title: 'T', oneLiner: 'O', gap: '', evidence: IDEA_UNVERIFIED },
    ],
  }, pool)
  assert.equal(out.report.ideas.length, 0)
  assert.equal(out.dropped.malformedIdea, 3)
})

test('ideas are capped at maxIdeas', () => {
  const ideas = []
  for (let i = 0; i < 8; i++) {
    ideas.push({ title: 'T' + i, oneLiner: 'O', gap: 'G', evidence: IDEA_UNVERIFIED })
  }
  const out = validateReport({ ideas: ideas }, pool, { maxIdeas: 2 })
  assert.equal(out.report.ideas.length, 2)
})

test('unusable input yields an empty report instead of throwing', () => {
  for (const value of [undefined, null, 42, 'text']) {
    const out = validateReport(value, pool)
    assert.equal(out.ok, false)
    assert.deepEqual(out.report.picks, [])
    assert.deepEqual(out.report.ideas, [])
  }
  assert.equal(validateReport({}, undefined).report.picks.length, 0)
})

test('parseReportJson tolerates code fences and surrounding prose', () => {
  assert.deepEqual(parseReportJson('```json\n{"picks":[]}\n```'), { picks: [] })
  assert.deepEqual(parseReportJson('好的，结果如下：{"picks":[],"notes":"x"} 完毕'), { picks: [], notes: 'x' })
  assert.deepEqual(parseReportJson('{"a":{"b":1}}'), { a: { b: 1 } })
})

test('parseReportJson returns undefined on unusable replies', () => {
  for (const value of ['', 'no json at all', '{broken', undefined, null]) {
    assert.equal(parseReportJson(value), undefined)
  }
})

test('the prompt states the caps and forbids inventing candidates', () => {
  const prompt = buildReportPrompt({
    date: '2026-10-08',
    brief: '## 这位用户是谁\n喜欢自动化',
    candidates: pool,
    maxRecommend: 7,
    maxIdeas: 2,
  })
  assert.ok(prompt.includes('最多 7 个'))
  assert.ok(prompt.includes('最多 2 个'))
  assert.ok(prompt.includes(IDEA_UNVERIFIED))
  assert.ok(prompt.includes('acme/dsh-alpha'))
  assert.ok(prompt.includes('acme/dsh-beta'))
  assert.ok(prompt.includes('不许编造'))
})
