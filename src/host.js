// Host half of dsh-daily.
//
// Every day at a configured local hour this produces one brief: improvements on
// plugins other people have already published — each anchored on a real repo
// from the corpus, each carrying a concrete delta and its own gap evidence.
// The user approves one in the GUI, and the approval is handed to a live agent
// with a contract that requires an INDEPENDENT implementation in the user's own
// repository (never a fork). This plugin does not develop anything itself; it
// schedules and presents.
//
// Failure posture matches the rest of this author's plugins: nothing here is
// allowed to take the harness down. A missing corpus, an unreachable model, an
// unreadable profile or a busy agent all degrade to a reported state.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadCorpus } from './corpus.js'
import { selectCandidates } from './select.js'
import { buildProfileBrief, loadProfileSources } from './profile.js'
import { buildReportPrompt, parseReportJson, salvageReport, validateReport } from './report.js'
import { buildApprovalMessage } from './deliver.js'
import { sessionTitleFor, spawnSession } from './spawn.js'
import { dayKey, missedToday, msUntilNext } from './schedule.js'

export const name = 'dsh-daily'
// `agents` is deliberately NOT injected: the service is looked up defensively
// through ctx.get() at approval time, so a composition without it (or a rename
// upstream) degrades to a reported refusal instead of blocking plugin load.
export const inject = ['timer', 'webServer']

const DEFAULT_CONFIG = {
  hour: 11,
  minute: 0,
  maxCandidates: 60,
  maxImprovements: 10,
  maxIdeas: 3,
  perCategory: 4,
  historyKeep: 30,
  // Raised from 8000 after a real truncation. The report grew when every `delta`
  // became a concrete sentence, and reasoning tokens count against this budget
  // on deepseek-flash, so the old figure no longer covered reasoning plus ten
  // detailed items.
  maxTokens: 16000,
  profileName: 'desktop',
  // Deliberately no machine-specific paths here: this file ships publicly, and
  // a hard-coded path would also make the plugin useless on anyone else s
  // machine. Local values belong in $DSH_HOME/daily/config.json, which never
  // enters the repository.
  corpusPath: undefined,
  seedCorpus: undefined,
  projectsRoot: undefined,
  templateRoot: undefined,
}

const IDEA_TITLES_KEEP = 40

const EDITOR_SYSTEM = [
  '你是 DeepSeek Harness 插件生态的每日改进编辑。',
  '你的读者是这个生态里的开发者本人，不是泛泛的科技爱好者。',
  '他不要把别人的仓库 fork 过来改，他要独立实现一个更好的版本。',
  '你只依据给定的候选清单和用户画像工作，不补充任何你「记得」的信息。',
  '宁可少选，不可凑数。',
].join('\n')

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch (error) {
    return false
  }
}

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    return undefined
  }
}

/**
 * Per-machine settings, kept outside the repository. A hand-edited file must
 * never be able to break plugin loading, so every failure returns {}.
 */
function readLocalConfig(path) {
  const raw = readTextFile(path)
  if (raw === undefined) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > 1048576) req.destroy()
    })
    req.on('end', function () {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolve({})
      }
    })
    req.on('error', function () {
      resolve({})
    })
  })
}

function methodFromUrl(url) {
  const path = String(url || '').split('?')[0]
  const rest = path.replace(/^\/dsh-daily\/?/, '')
  return rest || 'state'
}

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const dshHome = typeof settings.dshHome === 'string' ? settings.dshHome : (process.env.DSH_HOME || join(homedir(), '.dsh'))
  const codexHome = typeof settings.codexHome === 'string' ? settings.codexHome : join(homedir(), '.codex')
  const dataDir = typeof settings.dataDir === 'string' ? settings.dataDir : join(dshHome, 'daily')

  // Precedence: explicit config > $DSH_HOME/daily/config.json > generic defaults.
  const cfg = Object.assign({}, DEFAULT_CONFIG, readLocalConfig(join(dataDir, 'config.json')), settings)
  cfg.dshHome = dshHome
  cfg.codexHome = codexHome
  cfg.dataDir = dataDir

  const projectsRoot = typeof cfg.projectsRoot === 'string' && cfg.projectsRoot.length > 0
    ? cfg.projectsRoot
    : join(homedir(), 'Projects')
  const templateRoot = typeof cfg.templateRoot === 'string' ? cfg.templateRoot : ''

  const reportsDir = join(dataDir, 'reports')
  const corpusPath = typeof cfg.corpusPath === 'string' ? cfg.corpusPath : join(dataDir, 'corpus.csv')
  const statePath = join(dataDir, 'state.json')
  const approvalsPath = join(dataDir, 'approvals.jsonl')

  const persisted = (function () {
    try {
      const parsed = JSON.parse(readTextFile(statePath) || '{}')
      return {
        seen: Array.isArray(parsed.seen) ? parsed.seen : [],
        ideaTitles: Array.isArray(parsed.ideaTitles) ? parsed.ideaTitles : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
        approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
      }
    } catch (error) {
      return { seen: [], ideaTitles: [], history: [], approvals: [] }
    }
  })()

  const seen = persisted.seen
  // Ideas have no source repo to dedupe on, so they are remembered by title and
  // fed back into the prompt. Without this the same direction reappears daily.
  const ideaTitles = persisted.ideaTitles.slice(-IDEA_TITLES_KEEP)
  const history = persisted.history
  const approvals = persisted.approvals

  let running = false
  let lastError
  let lastRunAt
  let today = undefined
  let timer
  let nextRunAt
  let catchUpTimer

  function saveState() {
    if (!ensureDir(dataDir)) return
    try {
      writeFileSync(statePath, JSON.stringify({
        seen: seen, ideaTitles: ideaTitles, history: history, approvals: approvals,
      }, null, 2))
    } catch (error) {
      // Persistence is best effort; losing the index must not stop the daily run.
    }
  }

  // `sessionController.prompt` takes an AbortSignal and calls
  // `signal.throwIfAborted()` on it without optional chaining, so a missing
  // signal kills the hand-off *after* the window has already been created. That
  // is exactly how the first live run failed.
  //
  // One plugin-scoped controller, not one per click: the signal's lifetime must
  // outlive the HTTP request that triggered it (the request returns 202-style
  // acknowledgement while the first turn is still starting), and it must be
  // aborted only when the plugin unloads. A fresh controller per request would
  // work too, but then nothing could cancel an in-flight prompt on unload.
  let approvalAbort

  function approvalSignal() {
    if (approvalAbort === undefined || approvalAbort.signal.aborted) approvalAbort = new AbortController()
    return approvalAbort.signal
  }

  ctx.effect(function () {
    return function () {
      if (approvalAbort !== undefined) approvalAbort.abort()
    }
  })

  function seedCorpusIfNeeded() {
    if (existsSync(corpusPath)) return
    if (typeof cfg.seedCorpus !== 'string' || !existsSync(cfg.seedCorpus)) return
    if (!ensureDir(dataDir)) return
    try {
      writeFileSync(corpusPath, readFileSync(cfg.seedCorpus))
    } catch (error) {
      // A failed seed just means an empty corpus, which runDaily reports.
    }
  }

  function currentSelection() {
    const models = ctx.get('agentDefaultModel')
    if (models === undefined) return undefined
    try {
      const selection = models.currentSelection()
      if (selection && selection.provider && selection.model) {
        return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
      }
    } catch (error) {
      return undefined
    }
    return undefined
  }

  async function firstRoute(llm) {
    try {
      const providers = llm.listProviders()
      for (const entry of providers) {
        const models = await llm.listModels(entry.id)
        if (models.length > 0) return { provider: entry.id, model: models[0].id }
      }
    } catch (error) {
      return undefined
    }
    return undefined
  }

  async function ask(prompt) {
    const llm = ctx.get('llm')
    if (llm === undefined) return { failed: 'no-llm' }
    let selection = currentSelection()
    if (selection === undefined) selection = await firstRoute(llm)
    if (selection === undefined) return { failed: 'no-route' }

    const options = {
      provider: selection.provider,
      model: selection.model,
      system: EDITOR_SYSTEM,
      messages: [{
        id: 'daily-' + Date.now(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        // 这一条和 deliver.js 里那条不是一回事：这里的 source 只是**LLM 请求的
        // 元数据**，不会进入会话的持久槽位，所以 v4 的那条 producer-owned 校验
        // 不适用于它。实测（dsh-holdem 的 askAgent 用同样的形状）模型调用正常成功，
        // 所以**故意保持原样**，不要"顺手"改它再引入一次无法验证的改动。
        source: { kind: 'plugin', plugin: 'daily' },
      }],
      temperature: 0.3,
      maxTokens: cfg.maxTokens,
    }
    if (selection.reasoningEffort) options.reasoningEffort = selection.reasoningEffort

    // Model-side failures surface as a terminating finish chunk, not an exception.
    // A `length` finish is recorded as well: a truncated reply parses to nothing,
    // and that has to read as a generation failure rather than as a quiet day.
    let out = ''
    let finish = 'none'
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta' && chunk.text) {
        out += chunk.text
      } else if (chunk.type === 'finish' && chunk.reason) {
        finish = chunk.reason.kind === undefined ? 'unknown' : String(chunk.reason.kind)
        if (finish === 'error' || finish === 'aborted') {
          const message = chunk.reason.failure && chunk.reason.failure.message
          return { failed: message || ('finish ' + finish) }
        }
      }
    }
    return { text: out, route: selection.provider + '/' + selection.model, finish: finish }
  }

  // One unparseable reply must never become an empty report. A single retry with
  // a stricter instruction turns a flaky generation into a rare failure, and the
  // raw text of a double failure is kept so the reason is visible in the GUI.
  const STRICT_SUFFIX = '\n\n## 再试一次\n你上一次的回复无法解析成 JSON。这次**只输出那个 JSON 对象本身**，不要 markdown 代码块，不要任何前后文字。'

  // The diversity retry. The brief the model reads is drawn from engineering
  // memory and conventions, so it defaults to an all-tooling report; the prompt
  // asks for range, and this is what happens when the model ignores it. It is a
  // retry rather than a rejection because the content is usually fine — it is
  // the selection that is narrow.
  const DIVERSITY_SUFFIX = [
    '\n\n## 再试一次',
    '你上一次的回复里所有条目都是同一个 `type`，不符合第 9 条。',
    '重新出一份：**至少覆盖 3 种 `type`**，并且真的去候选里找游戏、外观、语音、趣味、传播这些分类。',
    '这位用户是工程师，但他自己写过游戏插件，他的兴趣不限于开发工具。不要再来一份全是工具和门禁的清单。',
    '其余规则不变。只输出那个 JSON 对象本身，不要任何前后文字。',
  ].join('\n')

  function itemCount(parsed) {
    if (parsed === undefined || parsed === null) return -1
    const improvements = Array.isArray(parsed.improvements) ? parsed.improvements.length : 0
    const ideas = Array.isArray(parsed.ideas) ? parsed.ideas.length : 0
    return improvements + ideas
  }

  // The harness spells the exhausted-budget finish `max-tokens`; `length` is the
  // other spelling seen for the same condition. Both mean the same thing and
  // neither is worth getting wrong, so both are recognised.
  function isTruncated(finish) {
    return finish === 'max-tokens' || finish === 'length'
  }

  // The size retry. Asking for the same thing again would run out of budget
  // again, so this asks for less of it instead — a shorter report that finishes
  // beats a fuller one that is cut in half.
  const BUDGET_SUFFIX = [
    '\n\n## 再试一次',
    '你上一次的回复**被输出长度上限截断了**，最后一条没有写完。',
    '这次大幅缩短：**最多 4 个 `improvements`、2 个 `ideas`**，其余规则不变。',
    '`delta`、`why`、`gap` 每条各控制在 60 字以内，但必须仍然具体——**写不完整不如少写几条**。',
    '只输出那个 JSON 对象本身，不要任何前后文字。',
  ].join('\n')

  /**
   * Ask until the reply is a usable report.
   *
   * @param {string} prompt
   * @param {(parsed:object)=>{accept:boolean,suffix?:string}} [assess]
   *   Optional extra gate on a parseable reply. Declining it costs one more call.
   */
  async function composeReport(prompt, assess) {
    const attempts = []
    let last = { text: '', finish: 'none' }
    let best
    let suffix = ''
    for (let attempt = 1; attempt <= 2; attempt = attempt + 1) {
      const result = await ask(prompt + suffix)
      if (result.failed !== undefined) {
        attempts.push({ attempt: attempt, failed: result.failed })
        suffix = STRICT_SUFFIX
        continue
      }
      last = { text: result.text, finish: result.finish, route: result.route }

      const whole = parseReportJson(result.text)
      const salvaged = whole === undefined ? salvageReport(result.text) : undefined
      const parsed = whole !== undefined ? whole : salvaged
      const truncated = isTruncated(result.finish)
      attempts.push({
        attempt: attempt,
        chars: result.text.length,
        finish: result.finish,
        parsed: parsed !== undefined,
        salvaged: salvaged !== undefined,
        truncated: truncated,
      })

      if (parsed === undefined) {
        suffix = truncated ? BUDGET_SUFFIX : STRICT_SUFFIX
        continue
      }

      const verdict = assess === undefined ? { accept: true } : assess(parsed)
      const candidate = {
        parsed: parsed,
        text: result.text,
        finish: result.finish,
        route: result.route,
        salvaged: salvaged !== undefined,
        truncated: truncated,
      }

      // A complete answer that also passes the extra gate is final — but only if
      // it is not a step backwards. A "complete" empty reply must not beat a
      // truncated one that actually produced items: telling the user there is
      // nothing worth doing is worse than telling them there is more to come.
      const better = best === undefined || itemCount(candidate.parsed) >= itemCount(best.parsed)
      if (verdict.accept && !candidate.salvaged && better) {
        return Object.assign({ attempts: attempts }, candidate)
      }

      // Otherwise this is the floor: a retry must never turn a usable report into
      // no report, and if the retry produces more items the better one wins.
      // Running out of budget outranks the diversity wish — a complete report
      // matters more than a wider one.
      if (best === undefined || itemCount(candidate.parsed) > itemCount(best.parsed)) best = candidate
      suffix = truncated ? BUDGET_SUFFIX : (verdict.suffix === undefined ? STRICT_SUFFIX : verdict.suffix)
    }
    if (best !== undefined) return Object.assign({ attempts: attempts }, best)
    return { parsed: undefined, text: last.text, finish: last.finish, route: last.route, attempts: attempts }
  }

  function loadReport(date) {
    const raw = readTextFile(join(reportsDir, date + '.json'))
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw)
    } catch (error) {
      return undefined
    }
  }

  async function runDaily(trigger) {
    if (running) return { ok: false, reason: 'already-running' }
    running = true
    lastRunAt = Date.now()
    try {
      seedCorpusIfNeeded()
      const date = dayKey(new Date())
      const entries = loadCorpus(corpusPath)
      if (entries.length === 0) throw new Error('语料读不到内容：' + corpusPath)

      const profileSources = loadProfileSources({ dshHome: dshHome, codexHome: codexHome, profileName: cfg.profileName })
      const brief = buildProfileBrief(profileSources, cfg.budgets)
      const pool = selectCandidates(entries, {
        installed: profileSources.installed,
        seen: seen,
        max: cfg.maxCandidates,
        perCategory: cfg.perCategory,
      })
      if (pool.picked.length === 0) throw new Error('预筛后没有候选：语料可能已被 seen 列表耗尽')

      const prompt = buildReportPrompt({
        date: date,
        brief: brief,
        candidates: pool.picked,
        maxImprovements: cfg.maxImprovements,
        maxIdeas: cfg.maxIdeas,
        pastIdeas: ideaTitles,
      })
      const composed = await composeReport(prompt, function (parsed) {
        // Pure and cheap, so the double validation is not worth caching.
        const probe = validateReport(parsed, pool.picked, {
          maxImprovements: cfg.maxImprovements,
          maxIdeas: cfg.maxIdeas,
        })
        if (!probe.report.monotone) return { accept: true }
        return { accept: false, suffix: DIVERSITY_SUFFIX }
      })
      if (composed.route === undefined) {
        throw new Error('生成失败：' + composed.attempts.map(function (entry) {
          return entry.failed === undefined ? ('finish ' + entry.finish) : entry.failed
        }).join(' / '))
      }

      const validation = validateReport(composed.parsed, pool.picked, {
        maxImprovements: cfg.maxImprovements,
        maxIdeas: cfg.maxIdeas,
      })
      const report = {
        date: date,
        generatedAt: new Date().toISOString(),
        trigger: trigger,
        model: composed.route,
        corpus: { path: corpusPath, total: entries.length },
        pool: { size: pool.picked.length, stats: pool.stats },
        profile: {
          installed: profileSources.installed,
          sources: profileSources.sources.map(function (source) {
            return { label: source.label, path: source.path, chars: source.text.length }
          }),
          missing: profileSources.missing,
        },
        improvements: validation.report.improvements,
        ideas: validation.report.ideas,
        notes: validation.report.notes,
        typeCounts: validation.report.typeCounts,
        monotone: validation.report.monotone,
        // Honest bookkeeping for a reply that ran out of budget: the items in
        // hand are real, and the fact that more were cut off is stated rather
        // than hidden behind a full-looking report.
        truncated: composed.truncated === true,
        salvaged: composed.salvaged === true,
        dropped: validation.dropped,
        parsed: validation.ok,
        // Kept so a reply that parsed to nothing is diagnosable from the GUI
        // instead of looking like a day with nothing worth recommending.
        reply: {
          chars: composed.text.length,
          finish: composed.finish,
          attempts: composed.attempts,
          head: composed.text.slice(0, 2000),
        },
      }

      if (!ensureDir(reportsDir)) throw new Error('报告目录不可写：' + reportsDir)
      writeFileSync(join(reportsDir, date + '.json'), JSON.stringify(report, null, 2))

      // `seen` holds the SOURCE repos: every improvement is anchored on one, so
      // remembering the anchor is what stops the same source coming back.
      for (const item of report.improvements) {
        if (seen.indexOf(item.basedOn) < 0) seen.push(item.basedOn)
      }
      for (const idea of report.ideas) {
        if (ideaTitles.indexOf(idea.title) < 0) ideaTitles.push(idea.title)
      }
      while (ideaTitles.length > IDEA_TITLES_KEEP) ideaTitles.shift()
      const entry = {
        date: date,
        at: report.generatedAt,
        improvements: report.improvements.length,
        ideas: report.ideas.length,
        model: report.model,
        drops: validation.dropped,
      }
      const existing = history.findIndex(function (item) { return item.date === date })
      if (existing >= 0) history[existing] = entry
      else history.push(entry)
      while (history.length > cfg.historyKeep) history.shift()

      today = report
      if (validation.ok) {
        lastError = undefined
      } else {
        // An unparseable reply is a generation failure. Saying so is the whole
        // point: an empty report must never be mistaken for a quiet day.
        // `max-tokens` gets its own sentence because it is the one cause the
        // user can actually act on, and it is not obvious: reasoning tokens are
        // counted against the same budget as the JSON.
        const truncated = isTruncated(composed.finish)
        lastError = '模型没有返回可解析的 JSON（已试 ' + composed.attempts.length + ' 次，最后 finish=' +
          composed.finish + '，收到 ' + composed.text.length + ' 字符）' +
          (truncated
            ? '。finish=max-tokens 表示输出预算被用尽——推理 token 也计入 maxTokens，可调高 maxTokens 或减少条目数。'
            : '')
      }
      saveState()
      return {
        ok: validation.ok,
        date: date,
        improvements: report.improvements.length,
        ideas: report.ideas.length,
      }
    } catch (error) {
      lastError = String((error && error.message) || error)
      return { ok: false, reason: lastError }
    } finally {
      running = false
    }
  }

  // Clicking 「做这个」 OPENS A NEW SESSION named after the item and starts it on
  // the build contract. It deliberately does not touch the session the user is
  // currently working in: the contract is long, it belongs to its own window,
  // and the finished work should not be tangled with unrelated history.
  //
  // Re-clicking the same item is a no-op that replays the previous outcome. Two
  // clicks inside a second used to deliver the whole contract twice and burn a
  // full development round on a duplicate session, so the guard is part of the
  // contract here rather than left to the GUI's disabled button.
  async function spawnFor(item, label) {
    const title = sessionTitleFor(item)
    const replayed = approvals.find(function (entry) {
      return entry.title === title && entry.spawned === true
    })
    if (replayed !== undefined) {
      return {
        spawned: true,
        replayed: true,
        sessionId: replayed.sessionId,
        title: title,
        delivered: true,
        reason: '',
      }
    }

    const contract = buildApprovalMessage(item, { projectsRoot: projectsRoot, templateRoot: templateRoot })
    const outcome = await spawnSession(
      {
        // The session controller is the GUI's own route into a workspace-attached
        // session, so it is preferred; the agent factory is the fallback. Both are
        // looked up defensively: an older composition without either must report a
        // refusal, not fail to load.
        sessionController: ctx.get('sessionController'),
        agents: ctx.get('agents'),
        workspaceRegistry: ctx.get('workspaceRegistry'),
        sessions: ctx.get('sessions'),
        titles: ctx.get('sessionTitle'),
        model: currentSelection(),
        // `sessionController.prompt` REQUIRES an AbortSignal — it calls
        // `signal.throwIfAborted()` without optional chaining, so passing none
        // fails after the window already exists. A plugin-scoped signal is the
        // right lifetime: the first turn must survive the HTTP request that
        // started it, and must be cancelled if the plugin unloads.
        signal: approvalSignal(),
      },
      { item: item, contract: contract, cwd: projectsRoot, plugin: 'daily' },
    )

    const record = {
      at: Date.now(),
      label: label,
      title: title,
      spawned: outcome.spawned === true,
      via: outcome.via === undefined ? '' : String(outcome.via),
      sessionId: outcome.sessionId === undefined ? '' : String(outcome.sessionId),
      // Kept for the existing state file and for the panel's own wording.
      delivered: outcome.spawned === true,
      reason: outcome.reason === undefined ? '' : String(outcome.reason),
    }
    approvals.push(record)
    while (approvals.length > 50) approvals.shift()
    try {
      if (ensureDir(dataDir)) appendFileSync(approvalsPath, JSON.stringify(record) + '\n')
    } catch (error) {
      // audit is best effort
    }
    saveState()
    return record
  }

  function approvalFor(payload) {
    const report = today !== undefined ? today : loadReport(dayKey(new Date()))
    if (report === undefined) return undefined
    const improvements = report.improvements || []
    const ideas = report.ideas || []
    // Titles are unique within the report, so a title is enough to address
    // either list; `basedOn` addresses an improvement by its source repo.
    if (typeof payload.title === 'string') {
      const improved = improvements.find(function (item) { return item.title === payload.title })
      if (improved !== undefined) {
        return { item: Object.assign({ kind: 'improvement' }, improved), label: 'improvement' }
      }
      const idea = ideas.find(function (item) { return item.title === payload.title })
      if (idea !== undefined) return { item: Object.assign({ kind: 'idea' }, idea), label: 'idea' }
    }
    if (typeof payload.basedOn === 'string') {
      const bySource = improvements.find(function (item) { return item.basedOn === payload.basedOn })
      if (bySource !== undefined) {
        return { item: Object.assign({ kind: 'improvement' }, bySource), label: 'improvement' }
      }
    }
    return undefined
  }

  // There is no retry queue any more, and its absence is the point: the old path
  // had to wait for an idle root session because it borrowed one. A new session
  // has nothing to wait for, so a failure is reported to the user instead of
  // being retried behind their back — retrying automatically could open a second
  // window for an item that already got one.

  function disarm(t) {
    if (t === undefined) return
    try {
      if (typeof ctx.clearTimeout === 'function') ctx.clearTimeout(t)
      else clearTimeout(t)
    } catch (error) {
      // A stale timer that still fires only re-arms; the running guard makes a
      // duplicate daily run harmless.
    }
  }

  function arm() {
    disarm(timer)
    const delay = msUntilNext(cfg.hour, cfg.minute, new Date())
    nextRunAt = Date.now() + delay
    timer = ctx.timeout(function () {
      timer = undefined
      runDaily('scheduled').then(arm, arm)
    }, delay)
  }

  function armCatchUp() {
    const existing = history.length > 0 ? history[history.length - 1].date : undefined
    if (!missedToday(cfg.hour, cfg.minute, new Date(), existing)) return
    catchUpTimer = ctx.timeout(function () {
      catchUpTimer = undefined
      runDaily('catch-up').then(function () {}, function () {})
    }, 5000)
  }

  seedCorpusIfNeeded()
  today = loadReport(dayKey(new Date()))
  if (today === undefined && history.length > 0) {
    const newest = history[history.length - 1].date
    today = loadReport(newest)
  }

  arm()
  armCatchUp()
  saveState()

  ctx.effect(function () {
    return function () {
      disarm(timer)
      disarm(catchUpTimer)
      timer = undefined
      catchUpTimer = undefined
    }
  })

  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-daily',
        handler: async function (req, res) {
          try {
            const method = methodFromUrl(req.url)
            const report = today !== undefined ? today : loadReport(dayKey(new Date()))

            // The URL-derived name and the HTTP verb are deliberately separate
            // checks. Folding them into one condition let DELETE /dsh-daily/state
            // answer 200, because the name alone satisfied the test.
            if (req.method === 'GET') {
              if (method !== 'state') {
                sendJson(res, 404, { error: 'unknown method' })
                return
              }
              sendJson(res, 200, {
                config: {
                  hour: cfg.hour,
                  minute: cfg.minute,
                  maxImprovements: cfg.maxImprovements,
                  maxIdeas: cfg.maxIdeas,
                  maxTokens: cfg.maxTokens,
                  corpusPath: corpusPath,
                  reportsDir: reportsDir,
                  profileName: cfg.profileName,
                },
                status: {
                  running: running,
                  lastRunAt: lastRunAt,
                  nextRunAt: nextRunAt,
                  lastError: lastError,
                  seen: seen.length,
                  // Historical name kept so an older client half still reads a
                  // number: nothing queues any more, because opening a new
                  // session never has to wait for an idle one.
                  pending: 0,
                },
                today: report,
                history: history.slice(-12).reverse(),
                approvals: approvals.slice(-12).reverse(),
              })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const body = await readBody(req)

            if (method === 'run') {
              if (running) {
                sendJson(res, 200, { ok: false, reason: 'already-running' })
                return
              }
              runDaily('manual').then(function () {}, function () {})
              sendJson(res, 202, { ok: true, started: true })
              return
            }
            if (method === 'approve') {
              const found = approvalFor(body)
              if (found === undefined) {
                sendJson(res, 404, { error: 'unknown-approval-target' })
                return
              }
              const record = await spawnFor(found.item, found.label)
              sendJson(res, 200, {
                ok: true,
                spawned: record.spawned,
                replayed: record.replayed === true,
                sessionId: record.sessionId || '',
                delivered: record.delivered,
                reason: record.reason,
                title: record.title,
              })
              return
            }
            if (method === 'skip') {
              if (typeof body.repo === 'string' && seen.indexOf(body.repo) < 0) {
                seen.push(body.repo)
                saveState()
              }
              sendJson(res, 200, { ok: true })
              return
            }
            sendJson(res, 404, { error: 'unknown method' })
          } catch (error) {
            sendJson(res, 500, { error: String((error && error.message) || error) })
          }
        },
      })
    } catch (error) {
      disposeRoute = undefined
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })
}
