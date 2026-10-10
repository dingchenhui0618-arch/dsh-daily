// Turns a prefiltered candidate pool plus the user brief into a daily report.
//
// The model does the judgement — which candidates matter for this particular
// person, and which plugins are worth building — because that is the part a
// scoring function cannot do. Everything this module guarantees is that the
// model cannot get away with inventing things:
//
//   * a pick whose repo is not in the pool is dropped, so no hallucinated
//     plugin can reach the user;
//   * a pick with an empty or boilerplate `why` is dropped;
//   * an idea must either cite evidence that actually appears in the pool, or
//     be explicitly marked as unverified speculation.
//
// All three rules are pure functions over the model's output, so they are
// unit-testable without a model.

export const IDEA_UNVERIFIED = '无直接证据'

// Phrases that mean nothing. If a `why` is built from these, the model dodged
// the question and the pick is not worth the user's attention.
const BOILERPLATE = [
  '很强大', '值得一试', '非常有用', '功能丰富', '值得关注', '很不错', '很有用',
  'powerful', 'useful', 'worth trying', 'great plugin',
]

export function buildReportPrompt(input) {
  const date = input.date
  const brief = input.brief
  const candidates = input.candidates || []
  const maxPicks = input.maxRecommend || 10
  const maxIdeas = input.maxIdeas || 3

  const rows = candidates.map(function (entry) {
    return '- ' + entry.repo + ' | ' + entry.category + ' | ' + entry.name + ' | ' + oneLine(entry.desc, 220)
  })

  return [
    '你是 DeepSeek Harness 插件生态的每日选品编辑。今天是 ' + date + '。',
    '',
    brief,
    '',
    '## 今天预筛出的候选（共 ' + candidates.length + ' 个，你只能从这里面选）',
    '',
    rows.join('\n'),
    '',
    '## 你要输出什么',
    '',
    '严格输出一个 JSON 对象。不要 markdown 代码块，不要任何解释文字，只输出 JSON：',
    '',
    '{',
    '  "picks": [ { "repo": "<必须与候选里的 repo 逐字一致>", "why": "<一句话：为什么对这个用户有用>" } ],',
    '  "ideas": [ { "title": "<插件名>", "oneLiner": "<一句话它做什么>", "gap": "<为什么生态里缺这个>", "evidence": "<证据>", "effort": "半天|1天|2-3天" } ],',
    '  "notes": "<一句话今日总结>"',
    '}',
    '',
    '## 规则',
    '',
    '1. `picks` 最多 ' + maxPicks + ' 个。**只能从上面的候选里选**，repo 必须逐字复制。',
    '   选不出够格的，`picks` 就给空数组——**凑数比空手更糟**。',
    '2. 每个 `why` 必须落到这位用户的具体工作或约束上。写「很强大」「值得一试」这类空话等于没写，会被丢弃。',
    '3. `ideas` 最多 ' + maxIdeas + ' 个，是**建议这位用户自己去做的插件**。',
    '   每个 idea 的 `evidence` 必须是二者之一：',
    '   - 一条**可核验**的线索（上面候选里的某个 repo 名，或一个 GitHub 链接），说明「现在没人做 / 做得很差」；',
    '   - 或者字面量「' + IDEA_UNVERIFIED + '」，表示你只是在推测。',
    '   **绝不许编造证据。** 拿不出证据又想提，就老实写「' + IDEA_UNVERIFIED + '」。',
    '4. 全部用中文。',
    '5. 不许编造候选里没有的插件名、star 数、作者名或下载量。',
  ].join('\n')
}

function oneLine(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/** Pull the first JSON object out of a model reply, tolerating code fences. */
export function parseReportJson(text) {
  if (typeof text !== 'string') return undefined
  const body = text.replace(/```json/gi, '```')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch (error) {
    return undefined
  }
}

function normaliseRepo(repo) {
  return String(repo || '').trim().toLowerCase()
}

function isBoilerplate(why) {
  const text = String(why || '').trim()
  if (text.length < 12) return true
  const lowered = text.toLowerCase()
  const hits = BOILERPLATE.filter(function (word) { return lowered.indexOf(word.toLowerCase()) >= 0 })
  // A `why` is only boilerplate when it is nothing but praise: one hollow word
  // inside a concrete sentence is still a concrete sentence.
  return hits.length > 0 && text.replace(/[，。、,.!！\s]/g, '').length <= 24
}

/**
 * @param {object} parsed raw model output
 * @param {Array<{repo:string,name:string,url:string,category:string,desc:string}>} pool
 * @param {{maxRecommend?:number, maxIdeas?:number}} [options]
 */
export function validateReport(parsed, pool, options) {
  const settings = options || {}
  const maxRecommend = settings.maxRecommend || 10
  const maxIdeas = settings.maxIdeas || 3
  const dropped = { hallucinated: 0, noWhy: 0, boilerplateWhy: 0, duplicate: 0, malformedIdea: 0 }

  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return { report: { picks: [], ideas: [], notes: '' }, dropped: dropped, ok: false }
  }

  const byRepo = new Map()
  const poolNames = []
  for (const entry of pool || []) {
    const key = normaliseRepo(entry.repo)
    if (!byRepo.has(key)) byRepo.set(key, entry)
    if (entry.name) poolNames.push(String(entry.name).toLowerCase())
    if (entry.repo) poolNames.push(String(entry.repo).toLowerCase())
  }

  const picks = []
  const used = new Set()
  for (const raw of Array.isArray(parsed.picks) ? parsed.picks : []) {
    if (!raw || typeof raw !== 'object') continue
    const key = normaliseRepo(raw.repo)
    const entry = byRepo.get(key)
    if (entry === undefined) {
      dropped.hallucinated = dropped.hallucinated + 1
      continue
    }
    if (used.has(key)) {
      dropped.duplicate = dropped.duplicate + 1
      continue
    }
    const why = String(raw.why || '').trim()
    if (why.length === 0) {
      dropped.noWhy = dropped.noWhy + 1
      continue
    }
    if (isBoilerplate(why)) {
      dropped.boilerplateWhy = dropped.boilerplateWhy + 1
      continue
    }
    used.add(key)
    picks.push({
      repo: entry.repo,
      name: entry.name,
      url: entry.url,
      category: entry.category,
      desc: entry.desc,
      why: why,
    })
    if (picks.length >= maxRecommend) break
  }

  const ideas = []
  for (const raw of Array.isArray(parsed.ideas) ? parsed.ideas : []) {
    if (!raw || typeof raw !== 'object') {
      dropped.malformedIdea = dropped.malformedIdea + 1
      continue
    }
    const title = String(raw.title || '').trim()
    const oneLiner = String(raw.oneLiner || '').trim()
    const gap = String(raw.gap || '').trim()
    const evidence = String(raw.evidence || '').trim()
    if (title.length === 0 || oneLiner.length === 0 || gap.length === 0 || evidence.length === 0) {
      dropped.malformedIdea = dropped.malformedIdea + 1
      continue
    }
    // Claimed evidence must actually name something in the pool or link out.
    // Anything else is downgraded to an explicit guess rather than shown as a
    // finding — the difference between "nobody built this" and "I think nobody
    // built this" is the whole point of the column.
    const claimsVerified = evidence !== IDEA_UNVERIFIED
    const grounded = /https?:\/\//i.test(evidence) ||
      poolNames.some(function (name) { return name.length > 3 && evidence.toLowerCase().indexOf(name) >= 0 })
    ideas.push({
      title: title,
      oneLiner: oneLiner,
      gap: gap,
      evidence: evidence,
      effort: String(raw.effort || '').trim() || '未知',
      verified: claimsVerified && grounded,
    })
    if (ideas.length >= maxIdeas) break
  }

  return {
    report: { picks: picks, ideas: ideas, notes: String(parsed.notes || '').trim() },
    dropped: dropped,
    ok: true,
  }
}
