import test from 'node:test'
import { strict as assert } from 'node:assert'
import {
  EVIDENCE_UNVERIFIED,
  TYPES,
  buildReportPrompt,
  normaliseType,
  parseReportJson,
  salvageReport,
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

// A reply that ran out of output budget still contains finished items. This is
// the regression suite for a real failure: eight good improvements were once
// discarded because the ninth was unterminated, and the user saw "0 条" beside
// an error message.
function truncatedReply() {
  return [
    '{',
    '  "improvements": [',
    '    ' + JSON.stringify(imp('acme/dsh-alpha')),
    ',',
    '    ' + JSON.stringify(imp('acme/dsh-beta', { title: 'dsh-two', type: '外观' })),
    ',',
    '    {"basedOn":"acme/dsh-alpha","type":"工具","title":"dsh-half","delta":"这一条在写出过程',
  ].join('\n')
}

test('salvageReport recovers every item that finished, and only those', () => {
  const recovered = salvageReport(truncatedReply())
  assert.ok(recovered !== undefined)
  assert.equal(recovered.improvements.length, 2)
  assert.equal(recovered.improvements[0].basedOn, 'acme/dsh-alpha')
  assert.equal(recovered.improvements[1].type, '外观')
})

test('salvaged items go through the same validation as any other item', () => {
  // Salvage may add items; it must never be a way past the gates. The second
  // item is hollow and must still be dropped.
  const text = '{"improvements":[' +
    JSON.stringify(imp('acme/dsh-alpha')) + ',' +
    JSON.stringify(imp('acme/dsh-beta', { title: 'dsh-hollow', delta: '做得更好' })) +
    ']}'
  const out = validateReport(salvageReport(text), pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.dropped.hollowDelta, 1)
})

test('a brace or bracket inside a string does not confuse the scanner', () => {
  const text = '{"improvements":[{"basedOn":"acme/dsh-alpha","title":"dsh-x",' +
    '"delta":"比较 {before} 与 [after]，字符串里还有 } 和 ] 这些字符",' +
    '"why":"这是一个足够长的真实理由，不是空话",' +
    '"gap":"缺口在这里","evidence":"acme/dsh-alpha","effort":"1天"}]}'
  const recovered = salvageReport(text)
  assert.equal(recovered.improvements.length, 1)
  assert.ok(recovered.improvements[0].delta.includes('} 和 ]'))
})

test('salvageReport recovers ideas too, and both lists together', () => {
  const text = '{"improvements":[' + JSON.stringify(imp('acme/dsh-alpha')) + '],' +
    '"ideas":[{"title":"dsh-idea","type":"游戏","oneLiner":"一句话","gap":"缺口",' +
    '"evidence":"无直接证据","effort":"1天"},{"title":"dsh-cut'
  const recovered = salvageReport(text)
  assert.equal(recovered.improvements.length, 1)
  assert.equal(recovered.ideas.length, 1)
  assert.equal(recovered.ideas[0].type, '游戏')
})

test('salvageReport returns nothing when nothing finished', () => {
  // The fragment the earlier truncation test produces: the array opened and no
  // object ever closed.
  assert.equal(salvageReport('{"improvements":['), undefined)
  assert.equal(salvageReport('{"improvements":[{"basedOn":"x","title":"unterminated'), undefined)
  assert.equal(salvageReport('no json here'), undefined)
  assert.equal(salvageReport(''), undefined)
  assert.equal(salvageReport(undefined), undefined)
})

test('salvageReport ignores empty arrays rather than reporting a hollow success', () => {
  assert.equal(salvageReport('{"improvements":[],"ideas":[]}'), undefined)
})

test('normaliseType folds aliases, qualifiers and blanks onto the six types', () => {
  assert.deepEqual(TYPES, ['工具', '游戏', '趣味', '外观', '多媒体', '传播'])
  assert.equal(normaliseType('工具'), '工具')
  assert.equal(normaliseType('game'), '游戏')
  assert.equal(normaliseType('Themes'), '外观')
  assert.equal(normaliseType('语音'), '多媒体')
  assert.equal(normaliseType('工具类插件'), '工具')
  assert.equal(normaliseType('游戏/game'), '游戏')
  assert.equal(normaliseType(''), '未标注')
  assert.equal(normaliseType(undefined), '未标注')
  assert.equal(normaliseType(null), '未标注')
  assert.equal(normaliseType('随便什么'), '其他')
})

test('a Chinese title survives, and is not mistaken for a rename', () => {
  // Regression. nameKey used to strip everything outside [a-z0-9], so every
  // Chinese title collapsed to the empty string; sameName then called an empty
  // key a rename, and discarded the lot — while the prompt was asking the model
  // to write in Chinese. Eight of ten good improvements died this way.
  assert.equal(sameName('证据闭环审稿器', pool[0]), false)
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { title: '证据闭环审稿器' })] }, pool)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.report.improvements[0].title, '证据闭环审稿器')
  assert.equal(out.dropped.sameName, 0)
})

test('a Chinese title still matches a Chinese source name', () => {
  const entry = { name: '证据闭环审稿器', repo: 'acme/证据闭环审稿器', url: 'u', category: 'c', desc: 'd' }
  assert.equal(sameName('证据闭环审稿器', entry), true)
  assert.equal(sameName('证据-闭环-审稿器', entry), true)
})

test('a title with no letters or digits is counted apart from a rename', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { title: '!!!' })] }, pool)
  assert.equal(out.report.improvements.length, 0)
  assert.equal(out.dropped.noTitle, 1)
  assert.equal(out.dropped.sameName, 0, 'an unusable title is not a rename')
})

test('every item carries a type and the report counts them', () => {
  const out = validateReport({
    improvements: [
      imp('acme/dsh-alpha', { type: '游戏' }),
      imp('acme/dsh-beta', { title: 'dsh-other', type: '外观' }),
    ],
  }, pool)
  assert.equal(out.report.improvements[0].type, '游戏')
  assert.equal(out.report.improvements[1].type, '外观')
  assert.deepEqual(out.report.typeCounts, { 游戏: 1, 外观: 1 })
  assert.equal(out.report.monotone, false)
})

test('an all-one-type report is flagged monotone but its content is kept', () => {
  // The host retries once on this; discarding here would throw away good work.
  const out = validateReport({
    improvements: [imp('acme/dsh-alpha', { type: '工具' })],
    ideas: [{ title: 'dsh-x', type: '工具', oneLiner: 'O', gap: 'G', evidence: EVIDENCE_UNVERIFIED }],
  }, pool)
  assert.equal(out.report.monotone, true)
  assert.equal(out.report.improvements.length, 1)
  assert.equal(out.report.ideas.length, 1)
})

test('a report that omits type entirely is not monotone', () => {
  // Retrying on a missing field would burn a second model call for no gain; the
  // Tab shows 未标注 instead.
  const out = validateReport({
    improvements: [
      imp('acme/dsh-alpha'),
      imp('acme/dsh-beta', { title: 'dsh-other' }),
    ],
  }, pool)
  assert.deepEqual(out.report.typeCounts, { 未标注: 2 })
  assert.equal(out.report.monotone, false)
})

test('a single item is never monotone', () => {
  const out = validateReport({ improvements: [imp('acme/dsh-alpha', { type: '工具' })] }, pool)
  assert.equal(out.report.monotone, false)
})

test('an idea type is normalised too', () => {
  const out = validateReport({
    ideas: [{ title: 'dsh-x', type: 'share', oneLiner: 'O', gap: 'G', evidence: EVIDENCE_UNVERIFIED }],
  }, pool)
  assert.equal(out.report.ideas[0].type, '传播')
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
  // The report must not collapse into an all-tooling list just because the
  // profile brief it reads is drawn from engineering memory.
  assert.ok(prompt.includes('至少覆盖 3 种'), 'the prompt must require type diversity')
  assert.ok(prompt.includes('工具|游戏|趣味|外观|多媒体|传播'), 'the schema must enumerate the types')
  assert.ok(prompt.includes('德州扑克'), 'the prompt must name the evidence that his range is wider')
  assert.ok(prompt.includes('不要只盯着工程效率'))
})

test('past idea titles are fed back so the same direction is not proposed twice', () => {  const prompt = buildReportPrompt({
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
