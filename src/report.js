// Turns a prefiltered candidate pool plus the user brief into a daily report.
//
// The product decision this module encodes (user, 2026-10-10): he does not want
// a reading list. He wants two things, and both end in his OWN repository.
//
//   * `improvements` — push one step past work other people already published:
//     a concrete delta on a real source repo, never a fork.
//   * `ideas` — directions the ecosystem does not have yet, which he can start
//     from nothing.
//
// The model does the judgement, because deciding which published plugin is
// worth improving is exactly what a scoring function cannot do. Everything this
// module guarantees is that the model cannot invent or dodge:
//
//   * an improvement anchored on a repo that is not in the pool is dropped, so
//     no hallucinated source can reach the user;
//   * an improvement whose `delta` is missing or hollow ("做得更好") is dropped —
//     the delta IS the product, there is nothing to show without it;
//   * a proposal that merely reuses the source repo's own name is dropped,
//     because that is a rename-and-republish, not an independent improvement;
//   * an idea must carry a title, one-liner and gap, and its evidence must
//     either name something real or admit it is a guess.
//
// All rules are pure functions over the model's output, so they are unit
// testable without a model.

export const EVIDENCE_UNVERIFIED = '无直接证据'

/**
 * The report must spread across these kinds of work, not only the first one.
 *
 * Why this exists: the profile brief is drawn from the user's agent memory and
 * conventions, which are entirely about engineering discipline, so a model
 * reading it produced a report of nothing but developer tooling — eight items,
 * all gateways and ledgers. The candidate pool was never the problem: it is
 * already balanced across 23 ecosystem categories, and "Just for Fun",
 * "Themes & Appearance" and "Voice & Audio" were all in it. The bias was in the
 * instruction. The user builds games as well as tools (he wrote a Texas Hold'em
 * plugin), so the report has to be told to look wider.
 */
export const TYPES = ['工具', '游戏', '趣味', '外观', '多媒体', '传播']

// The model answers in either language and sometimes qualifies the label
// ("工具类插件"), so both are folded onto the six canonical types.
const TYPE_ALIASES = {
  tool: '工具', tools: '工具', utility: '工具', dev: '工具', developer: '工具', 功能: '工具', 开发: '工具',
  game: '游戏', games: '游戏', gaming: '游戏', 游戏类: '游戏',
  fun: '趣味', novelty: '趣味', toy: '趣味', 娱乐: '趣味', 玩具: '趣味',
  theme: '外观', themes: '外观', appearance: '外观', visual: '外观', ui: '外观', 视觉: '外观', 主题: '外观', 外观类: '外观',
  media: '多媒体', audio: '多媒体', voice: '多媒体', image: '多媒体', video: '多媒体', 音频: '多媒体', 图像: '多媒体', 语音: '多媒体',
  share: '传播', sharing: '传播', social: '传播', viral: '传播', 分享: '传播', 展示: '传播', 传播性: '传播',
}

/** Fold whatever the model wrote onto one of TYPES, or a visible fallback. */
export function normaliseType(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (raw === '') return '未标注'
  if (TYPES.indexOf(raw) >= 0) return raw
  const lower = raw.toLowerCase()
  if (TYPE_ALIASES[lower] !== undefined) return TYPE_ALIASES[lower]
  // Tolerate qualifiers such as "工具类插件" or "游戏/game".
  for (const type of TYPES) {
    if (raw.indexOf(type) >= 0) return type
  }
  for (const alias of Object.keys(TYPE_ALIASES)) {
    if (lower.indexOf(alias) >= 0) return TYPE_ALIASES[alias]
  }
  return '其他'
}

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
  const maxIdeas = input.maxIdeas || 3
  const pastIdeas = Array.isArray(input.pastIdeas) ? input.pastIdeas : []

  // The popularity column is real data taken from the market catalog, and the
  // list order is a consequence of it (see select.js). Both facts are stated
  // rather than implied: a model that does not know the numbers are real will
  // treat them as decoration, and one that does not know the order means
  // something will keep picking from the top row of the alphabet.
  const rows = candidates.map(function (entry) {
    const popularity = typeof input.popularityOf === 'function'
      ? input.popularityOf(entry)
      : (entry.popularity === undefined ? '' : entry.popularity)
    return '- ' + entry.repo + ' | ' + entry.category + ' | ' + entry.name + ' | ' + popularity + ' | ' + oneLine(entry.desc, 220)
  })

  return [
    '你是 DeepSeek Harness 插件生态的每日改进编辑。今天是 ' + date + '。',
    '',
    '你的读者是这个生态里的开发者本人。他**不要**「推荐我去装什么」。他要两样东西：',
    '一是**在别人已经发布的作品上往前走一步**——从下面这批别人做过的插件里挑出值得',
    '二次微调、功能优化或能力提升的，给出**具体的改法**；',
    '二是**生态里还没有的新方向**——他自己可以立的需求。',
    '两样他都会自己独立实现、发到自己的仓库——不是 fork，不是复刻。',
    '他也不是只要开发工具：他是工程师，但同样做游戏、做视觉、做好玩和能拿出去给人看的东西。',
    '候选清单覆盖整个生态（含游戏、外观、语音、趣味等分类），**不要只盯着工程效率**。',
    '',
    brief,
    '',
    '## 今天预筛出的候选（共 ' + candidates.length + ' 个，你只能从这里面挑）',
    '',
    '每行是：`repo | 分类 | 名字 | 安装热度 | 一句话描述`。**「安装热度」是从插件市场真实取到的**',
    '（下载量 / star 数）；显示「无热门度数据」表示市场没有这个数字，**不是** 0。',
    '候选**已按热度高的优先排**，越靠前说明装的人越多——**正在被大量使用的插件差在哪，比没人装过的',
    '插件更值得改**。这是排序依据，不是让你只挑最热的那几个：分类之间是均衡的，别把名额全给 ui 和 tools。',
    '',
    rows.join('\n'),
    ...(pastIdeas.length > 0 ? [
      '',
      '### 这些方向你已经提过了，不要重复',
      '',
      pastIdeas.map(function (title) { return '- ' + title }).join('\n'),
    ] : []),
    '',
    '## 你要输出什么',
    '',
    '严格输出一个 JSON 对象。不要 markdown 代码块，不要任何解释文字，只输出 JSON：',
    '',
    '{',
    '  "improvements": [',
    '    {',
    '      "basedOn": "<必须与候选里的 repo 逐字一致>",',
    '      "type": "<' + TYPES.join('|') + '>",',
    '      "title": "<小写 ASCII 的插件名，形如 dsh-xxx。它会直接变成仓库名和目录名>",',
    '      "delta": "<具体改什么：一句话说清「原版是 A，我要做成 B」>",',
    '      "why": "<一句话：为什么这个改动对这位用户有价值>",',
    '      "gap": "<原版做到哪一步、差在哪>",',
    '      "evidence": "<证据>",',
    '      "effort": "半天|1天|2-3天"',
    '    }',
    '  ],',
    '  "ideas": [',
    '    {',
    '      "title": "<小写 ASCII 的插件名，形如 dsh-xxx。它会直接变成仓库名和目录名>",',
    '      "type": "<' + TYPES.join('|') + '>",',
    '      "oneLiner": "<一句话它做什么>",',
    '      "gap": "<为什么生态里缺这个>",',
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
    '2. **`delta` 是改进项的全部价值。** 它必须是能落地的具体改动，说清改哪个点、改成什么样。',
    '   写「做得更好」「增强体验」「优化性能」「更加完善」这类空话等于没写，会被丢弃。',
    '3. **`title` 不能就是原仓库的名字或它的原名。** 这是独立实现，不是改名重发，会被丢弃。',
    '   两个 `title` 都必须是**小写 ASCII、用连字符连接的插件名（形如 `dsh-xxx`）**——',
    '   它会被直接当作 GitHub 仓库名和本地目录名，中文或空格都不行。其余字段用中文。',
    '4. 每个 `why` 必须落到这位用户身上：他的工作、他的项目，或者他真正会去玩、会去用的东西。不要泛泛而谈。',
    '5. `gap` 要说清原版覆盖到哪、缺口在哪。`evidence` 必须是二者之一：',
    '   - 上面候选里的某个 repo 名，或一个 GitHub 链接，说明这个缺口真实存在；',
    '   - 或者字面量「' + EVIDENCE_UNVERIFIED + '」，表示你只是在推测。',
    '   **绝不许编造证据。** 拿不出证据又想提，就老实写「' + EVIDENCE_UNVERIFIED + '」。',
    '6. `ideas` 最多 ' + maxIdeas + ' 个，是**生态里还没有、他自己可以立的新方向**——不是候选里已有的东西。',
    '   `title`、`oneLiner`、`gap`、`evidence` 一个都不能空，`evidence` 规则同第 5 条。',
    '   想到什么写什么，不必凑数；但「给某个现有插件加个功能」属于 `improvements`，不要塞进 `ideas`。',
    '7. 两条产出的共同点：不是复刻别人的东西，是把想法落到**他能验收的**实现上。',
    '8. 全部用中文。**star 数与下载量只能引用候选行里已经给出的数字**——没给就不许提，',
    '   更不许自己编一个；插件名与作者名同理，只能来自候选。',
    '9. **`type` 必须分散。** 每条的 `type` 只能取：' + TYPES.join(' / ') + '。',
    '   这位用户的兴趣**不限于开发工具**——他自己写过一个德州扑克插件，候选里也有游戏、外观、',
    '   语音、趣味这些分类。**一份日报里至少覆盖 3 种 `type`，并且要主动去找游戏、趣味、外观、',
    '   多媒体、传播方向**，不要把全部名额用在「提升工作效率」上。全是「工具」的日报算不合格。',
    '   判断标准不是「这个好玩」，而是「他会不会真的想去装/去做」——趣味插件同样要有具体价值。',
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

/**
 * Recover the finished items from a reply that was cut off mid-JSON.
 *
 * This exists because of a real failure, and the failure was this plugin's own
 * fault. Making every `delta` a concrete sentence roughly doubled the size of a
 * report, and `deepseek-flash` counts reasoning tokens against maxTokens, so a
 * reply can end at `finish=max-tokens` with several complete, high-quality
 * improvements already written and the last one unterminated. Rejecting the
 * whole reply then loses work the model actually did and shows the user "0 条"
 * next to an error — the worst of both outcomes.
 *
 * Only WHOLE objects are recovered, and they go through exactly the same
 * validation as anything else, so salvaging can add items but can never let a
 * malformed one through.
 */
export function salvageReport(text) {
  if (typeof text !== 'string') return undefined
  const start = text.indexOf('{')
  if (start < 0) return undefined
  const body = text.slice(start)
  const recovered = {}
  for (const key of ['improvements', 'ideas']) {
    const items = completeObjectsIn(body, key)
    if (items.length > 0) recovered[key] = items
  }
  return Object.keys(recovered).length > 0 ? recovered : undefined
}

/** The complete objects inside `"key": [ ... ]`, stopping at an unterminated one. */
function completeObjectsIn(body, key) {
  const match = new RegExp('"' + key + '"\\s*:\\s*\\[').exec(body)
  if (match === null) return []
  return scanCompleteObjects(body, match.index + match[0].length - 1)
}

/**
 * A string-aware brace scanner.
 *
 * String awareness is the whole point: braces and brackets inside `delta` text
 * are ordinary characters, and a scanner that counted them would slice the JSON
 * in the wrong place and read back garbage.
 */
function scanCompleteObjects(text, openIndex) {
  const found = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = openIndex + 1; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) {
          try {
            const item = JSON.parse(text.slice(start, i + 1))
            if (item !== null && typeof item === 'object' && !Array.isArray(item)) found.push(item)
          } catch (error) {
            // An object that will not parse on its own is not recoverable.
          }
          start = -1
        }
      }
      continue
    }
    // The list ended: nothing past it belongs to this array. Reaching the end of
    // the text instead means the reply was truncated, which is the case this
    // whole function is for.
    if (ch === ']' && depth === 0) break
  }

  return found
}

function normaliseRepo(repo) {
  return String(repo || '').trim().toLowerCase()
}

/**
 * Collapse a plugin name to comparable letters and digits.
 *
 * Unicode-aware on purpose. An earlier version stripped everything outside
 * [a-z0-9], which turned every Chinese title into the empty string — and since
 * the prompt asks for Chinese, every title a compliant model wrote compared
 * equal to every other one. With `sameName` treating an empty key as a rename,
 * eight of ten good improvements were being discarded as "rename-and-republish".
 * Names in this ecosystem are ASCII, but the model is not obliged to write one,
 * so the comparison must not destroy non-ASCII input.
 */
function nameKey(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
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
  // Nothing comparable in the title means it cannot be a rename of anything.
  // An unusable title is a different defect, counted separately as `noTitle`.
  if (key.length === 0) return false
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
  const maxIdeas = settings.maxIdeas || 3
  const dropped = {
    hallucinated: 0, noDelta: 0, hollowDelta: 0, noWhy: 0, boilerplateWhy: 0,
    malformed: 0, malformedIdea: 0, noTitle: 0, sameName: 0, duplicate: 0,
  }

  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return {
      report: { improvements: [], ideas: [], notes: '', typeCounts: {}, monotone: false },
      dropped: dropped,
      ok: false,
    }
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
  // A separate namespace for titles: improvements dedupe on their source repo,
  // but two items the user cannot tell apart by name are a defect regardless of
  // which list they came from (and `approve` addresses an item by title).
  const usedTitles = new Set()
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
    // The title becomes the repository name and the project directory, so a
    // title with no letters or digits in it cannot be used for either.
    if (nameKey(title).length === 0) {
      dropped.noTitle = dropped.noTitle + 1
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
    if (usedTitles.has(nameKey(title))) {
      dropped.duplicate = dropped.duplicate + 1
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
    usedTitles.add(nameKey(title))
    improvements.push({
      basedOn: entry.repo,
      basedOnName: entry.name,
      basedOnUrl: entry.url,
      category: entry.category,
      desc: entry.desc,
      title: title,
      type: normaliseType(raw.type),
      delta: delta,
      why: why,
      gap: gap,
      evidence: evidence,
      effort: String(raw.effort || '').trim() || '未知',
      verified: claimsVerified && grounded,
    })
    if (improvements.length >= maxImprovements) break
  }

  // From-scratch directions. There is no source repo to check these against, so
  // the only guarantees available are that the fields are present and that the
  // evidence either names something real or admits it is a guess.
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
    const key = nameKey(title)
    if (key.length === 0) {
      dropped.noTitle = dropped.noTitle + 1
      continue
    }
    if (usedTitles.has(key)) {
      dropped.duplicate = dropped.duplicate + 1
      continue
    }
    usedTitles.add(key)
    const claimsVerified = evidence !== EVIDENCE_UNVERIFIED
    const grounded = /https?:\/\//i.test(evidence) ||
      poolNames.some(function (name) { return name.length > 3 && evidence.toLowerCase().indexOf(name) >= 0 })
    ideas.push({
      title: title,
      type: normaliseType(raw.type),
      oneLiner: oneLiner,
      gap: gap,
      evidence: evidence,
      effort: String(raw.effort || '').trim() || '未知',
      verified: claimsVerified && grounded,
    })
    if (ideas.length >= maxIdeas) break
  }

  const all = improvements.concat(ideas)
  const typeCounts = {}
  for (const item of all) {
    typeCounts[item.type] = (typeCounts[item.type] || 0) + 1
  }
  const distinct = Object.keys(typeCounts)
  // One type across the whole report means the model ignored rule 9. That is not
  // a reason to throw away otherwise good content, so it is reported rather than
  // enforced here: the host retries once on it and the Tab says so. A model that
  // omitted `type` entirely is NOT monotone — that is a different failure, and
  // retrying on it would only burn a second call.
  const monotone = all.length >= 2 && distinct.length === 1 && distinct[0] !== '未标注'

  return {
    report: {
      improvements: improvements,
      ideas: ideas,
      notes: String(parsed.notes || '').trim(),
      typeCounts: typeCounts,
      monotone: monotone,
    },
    dropped: dropped,
    ok: true,
  }
}
