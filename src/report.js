// Turns a prefiltered candidate pool plus the user brief into a daily report.
//
// The product decision this module encodes (user, 2026-10-10): he does not want
// a reading list, and he does not want ideas invented out of nothing. He wants
// **improvements on work other people already published** — a concrete delta he
// can implement himself and ship in his OWN repository, never a fork.
//
// The model does the judgement, because deciding which published plugin is
// worth pushing one step further is exactly what a scoring function cannot do.
// Everything this module guarantees is that the model cannot invent or dodge:
//
//   * an improvement anchored on a repo that is not in the pool is dropped, so
//     no hallucinated source can reach the user;
//   * an improvement whose `delta` is missing or hollow ("做得更好") is dropped —
//     the delta IS the product, there is nothing to show without it;
//   * a proposal that merely reuses the source repo's own name is dropped,
//     because that is a rename-and-republish, not an independent improvement;
//   * claimed evidence must name something in the pool or link out, otherwise
//     it is downgraded to an explicit guess instead of shown as a finding.
//
// All rules are pure functions over the model's output, so they are unit
// testable without a model.

export const EVIDENCE_UNVERIFIED = '无直接证据'

// Words that mean nothing in a `why`. If one of these is all there is, the
// model dodged the question and the item is not worth the user's attention.
const BOILERPLATE_WHY = [
  '很强大', '值得一试', '非常有用', '功能丰富', '值得关注', '很不错', '很有用',
  'powerful', 'useful', 'worth trying', 'great plugin',
]

// Words that mean nothing in a `delta`. This list exists because "做得更好" is
// the single most likely way for the model to fake an improvement: it reads
// like an answer while specifying nothing at all.
const HOLLOW_DELTA = [
  '做得更好', '做得更完善', '更加完善', '更好用', '增强体验', '优化体验', '提升体验',
  '功能更强大', '增强功能', '优化性能', 'improve it', 'enhance it', 'optimize it',
]

export function buildReportPrompt(input) {
  const date = input.date
  const brief = input.brief
  const candidates = input.candidates || []
  const maxImprovements = input.maxImprovements || 10

  const rows = candidates.map(function (entry) {
    return '- ' + entry.repo + ' | ' + entry.category + ' | ' + entry.name + ' | ' + oneLine(entry.desc, 220)
  })

  return [
    '你是 DeepSeek Harness 插件生态的每日改进编辑。今天是 ' + date + '。',
    '',
    '你的读者是这个生态里的开发者本人。他**不要**「推荐我去装什么」，',
    '他要的是**在别人已经发布的作品上往前走一步**：从下面这批别人做过的插件里，',
    '挑出真正值得二次微调、功能优化或能力提升的，给出**具体的改法**。',
    '他会自己独立实现、发到自己的仓库——不是 fork，不是复刻。',
    '',
    brief,
    '',
    '## 今天预筛出的候选（共 ' + candidates.length + ' 个，你只能从这里面挑）',
    '',
    rows.join('\n'),
    '',
    '## 你要输出什么',
    '',
    '严格输出一个 JSON 对象。不要 markdown 代码块，不要任何解释文字，只输出 JSON：',
    '',
    '{',
    '  "improvements": [',
    '    {',
    '      "basedOn": "<必须与候选里的 repo 逐字一致>",',
    '      "title": "<你自己那个独立项目的名字，不能就是原仓库的名字>",',
    '      "delta": "<具体改什么：一句话说清「原版是 A，我要做成 B」>",',
    '      "why": "<一句话：为什么这个改动对这位用户有价值>",',
    '      "gap": "<原版做到哪一步、差在哪>",',
    '      "evidence": "<证据>",',
    '      "effort": "半天|1天|2-3天"',
    '    }',
    '  ],',
    '  "notes": "<一句话今日总结>"',
    '}',
    '',
    '## 规则',
    '',
    '1. `improvements` 最多 ' + maxImprovements + ' 个。**`basedOn` 只能从上面的候选里挑**，repo 必须逐字复制。',
    '   挑不出够格的就给空数组——**凑数比空手更糟**。',
    '2. **`delta` 是这份日报的全部价值。** 它必须是能落地的具体改动，说清改哪个点、改成什么样。',
    '   写「做得更好」「增强体验」「优化性能」「更加完善」这类空话等于没写，会被丢弃。',
    '3. **`title` 不能就是原仓库的名字或它的原名。** 这是独立实现，不是改名重发，会被丢弃。',
    '4. 每个 `why` 必须落到这位用户的具体工作或约束上，不要泛泛而谈。',
    '5. `gap` 要说清原版覆盖到哪、缺口在哪。`evidence` 必须是二者之一：',
    '   - 上面候选里的某个 repo 名，或一个 GitHub 链接，说明这个缺口真实存在；',
    '   - 或者字面量「' + EVIDENCE_UNVERIFIED + '」，表示你只是在推测。',
    '   **绝不许编造证据。** 拿不出证据又想提，就老实写「' + EVIDENCE_UNVERIFIED + '」。',
    '6. 不是让你复刻原版，是让你在它的**思路上往前走一步**：原版没解决的那部分由你来解决。',
    '7. 全部用中文。不许编造候选里没有的插件名、star 数、作者名或下载量。',
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

/** Collapse a plugin name to comparable letters and digits. */
function nameKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function lastSegment(repo) {
  const value = String(repo || '')
  return value.slice(value.lastIndexOf('/') + 1)
}

/**
 * A value is hollow when it is short, or when it is nothing but one of the
 * empty phrases: a real sentence that happens to contain "优化" is still a real
 * sentence, which is why the length test comes second.
 */
function isHollow(text, words) {
  const value = String(text || '').trim()
  if (value.length < 12) return true
  const lowered = value.toLowerCase()
  const hits = words.filter(function (word) { return lowered.indexOf(String(word).toLowerCase()) >= 0 })
  return hits.length > 0 && value.replace(/[，。、,.!！\s]/g, '').length <= 24
}

/**
 * True when the proposed title is just the source plugin's own name. Renaming
 * someone's repo and publishing it is the one outcome the user ruled out.
 */
export function sameName(title, entry) {
  const key = nameKey(title)
  if (key.length === 0) return true
  const taken = [
    nameKey(entry.name),
    nameKey(lastSegment(entry.repo)),
    // The whole `owner/repo` string too: a model that sets the title to the
    // full path is still renaming the source, not naming its own project.
    nameKey(entry.repo),
  ]
  return taken.some(function (candidate) { return candidate.length > 0 && candidate === key })
}

/**
 * @param {object} parsed raw model output
 * @param {Array<{repo:string,name:string,url:string,category:string,desc:string}>} pool
 * @param {{maxImprovements?:number}} [options]
 */
export function validateReport(parsed, pool, options) {
  const settings = options || {}
  const maxImprovements = settings.maxImprovements || 10
  const dropped = {
    hallucinated: 0, noDelta: 0, hollowDelta: 0, noWhy: 0, boilerplateWhy: 0,
    malformed: 0, sameName: 0, duplicate: 0,
  }

  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return { report: { improvements: [], notes: '' }, dropped: dropped, ok: false }
  }

  const byRepo = new Map()
  const poolNames = []
  for (const entry of pool || []) {
    const key = normaliseRepo(entry.repo)
    if (!byRepo.has(key)) byRepo.set(key, entry)
    if (entry.name) poolNames.push(String(entry.name).toLowerCase())
    if (entry.repo) poolNames.push(String(entry.repo).toLowerCase())
  }

  const improvements = []
  const used = new Set()
  for (const raw of Array.isArray(parsed.improvements) ? parsed.improvements : []) {
    if (!raw || typeof raw !== 'object') {
      dropped.malformed = dropped.malformed + 1
      continue
    }
    const key = normaliseRepo(raw.basedOn)
    const entry = byRepo.get(key)
    if (entry === undefined) {
      dropped.hallucinated = dropped.hallucinated + 1
      continue
    }
    if (used.has(key)) {
      dropped.duplicate = dropped.duplicate + 1
      continue
    }

    const title = String(raw.title || '').trim()
    const delta = String(raw.delta || '').trim()
    const why = String(raw.why || '').trim()
    const gap = String(raw.gap || '').trim()
    const evidence = String(raw.evidence || '').trim()

    if (title.length === 0 || gap.length === 0 || evidence.length === 0) {
      dropped.malformed = dropped.malformed + 1
      continue
    }
    if (delta.length === 0) {
      dropped.noDelta = dropped.noDelta + 1
      continue
    }
    if (isHollow(delta, HOLLOW_DELTA)) {
      dropped.hollowDelta = dropped.hollowDelta + 1
      continue
    }
    if (why.length === 0) {
      dropped.noWhy = dropped.noWhy + 1
      continue
    }
    if (isHollow(why, BOILERPLATE_WHY)) {
      dropped.boilerplateWhy = dropped.boilerplateWhy + 1
      continue
    }
    if (sameName(title, entry)) {
      dropped.sameName = dropped.sameName + 1
      continue
    }

    // Claimed evidence must actually name something in the pool or link out.
    // Anything else is downgraded to an explicit guess rather than shown as a
    // finding — the difference between "this gap is real" and "I think it is"
    // is the whole point of the column.
    const claimsVerified = evidence !== EVIDENCE_UNVERIFIED
    const grounded = /https?:\/\//i.test(evidence) ||
      poolNames.some(function (name) { return name.length > 3 && evidence.toLowerCase().indexOf(name) >= 0 })

    used.add(key)
    improvements.push({
      basedOn: entry.repo,
      basedOnName: entry.name,
      basedOnUrl: entry.url,
      category: entry.category,
      desc: entry.desc,
      title: title,
      delta: delta,
      why: why,
      gap: gap,
      evidence: evidence,
      effort: String(raw.effort || '').trim() || '未知',
      verified: claimsVerified && grounded,
    })
    if (improvements.length >= maxImprovements) break
  }

  return {
    report: { improvements: improvements, notes: String(parsed.notes || '').trim() },
    dropped: dropped,
    ok: true,
  }
}
