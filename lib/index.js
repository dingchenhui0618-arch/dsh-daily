// Host half of dsh-daily.
//
// Every day at a configured local hour this produces one brief: a shortlist of
// ecosystem plugins ranked against this user, plus a few buildable ideas that
// carry their own gap evidence. The user approves an idea in the GUI, and the
// approval is handed to a live agent — this plugin does not develop anything
// itself, it schedules and presents.
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
import { buildReportPrompt, parseReportJson, validateReport } from './report.js'
import { buildApprovalMessage, deliverToAgent } from './deliver.js'
import { dayKey, missedToday, msUntilNext } from './schedule.js'

export const name = 'dsh-daily'
export const inject = ['timer', 'webServer']

const DEFAULT_CONFIG = {
  hour: 11,
  minute: 0,
  maxCandidates: 60,
  maxRecommend: 10,
  maxIdeas: 3,
  perCategory: 4,
  historyKeep: 30,
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

const EDITOR_SYSTEM = [
  '你是 DeepSeek Harness 插件生态的每日选品编辑。',
  '你的读者是这个生态里的开发者本人，不是泛泛的科技爱好者。',
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
        history: Array.isArray(parsed.history) ? parsed.history : [],
        approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
      }
    } catch (error) {
      return { seen: [], history: [], approvals: [] }
    }
  })()

  const seen = persisted.seen
  const history = persisted.history
  const approvals = persisted.approvals
  const pending = []

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
      writeFileSync(statePath, JSON.stringify({ seen: seen, history: history, approvals: approvals }, null, 2))
    } catch (error) {
      // Persistence is best effort; losing the index must not stop the daily run.
    }
  }

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
        source: { kind: 'plugin', plugin: 'daily' },
      }],
      temperature: 0.3,
      maxTokens: 4000,
    }
    if (selection.reasoningEffort) options.reasoningEffort = selection.reasoningEffort

    // Model-side failures surface as a terminating finish chunk, not an exception.
    let out = ''
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta' && chunk.text) {
        out += chunk.text
      } else if (chunk.type === 'finish' && chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        const message = chunk.reason.failure && chunk.reason.failure.message
        return { failed: message || ('finish ' + chunk.reason.kind) }
      }
    }
    return { text: out, route: selection.provider + '/' + selection.model }
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
        maxRecommend: cfg.maxRecommend,
        maxIdeas: cfg.maxIdeas,
      })
      const generation = await ask(prompt)
      if (generation.failed !== undefined) throw new Error('生成失败：' + generation.failed)

      const validation = validateReport(parseReportJson(generation.text), pool.picked, {
        maxRecommend: cfg.maxRecommend,
        maxIdeas: cfg.maxIdeas,
      })

      const report = {
        date: date,
        generatedAt: new Date().toISOString(),
        trigger: trigger,
        model: generation.route,
        corpus: { path: corpusPath, total: entries.length },
        pool: { size: pool.picked.length, stats: pool.stats },
        profile: {
          installed: profileSources.installed,
          sources: profileSources.sources.map(function (source) {
            return { label: source.label, path: source.path, chars: source.text.length }
          }),
          missing: profileSources.missing,
        },
        picks: validation.report.picks,
        ideas: validation.report.ideas,
        notes: validation.report.notes,
        dropped: validation.dropped,
        parsed: validation.ok,
      }

      if (!ensureDir(reportsDir)) throw new Error('报告目录不可写：' + reportsDir)
      writeFileSync(join(reportsDir, date + '.json'), JSON.stringify(report, null, 2))

      for (const pick of report.picks) {
        if (seen.indexOf(pick.repo) < 0) seen.push(pick.repo)
      }
      const entry = {
        date: date,
        at: report.generatedAt,
        picks: report.picks.length,
        ideas: report.ideas.length,
        model: report.model,
        drops: validation.dropped,
      }
      const existing = history.findIndex(function (item) { return item.date === date })
      if (existing >= 0) history[existing] = entry
      else history.push(entry)
      while (history.length > cfg.historyKeep) history.shift()

      today = report
      lastError = undefined
      saveState()
      return { ok: true, date: date, picks: report.picks.length, ideas: report.ideas.length }
    } catch (error) {
      lastError = String((error && error.message) || error)
      return { ok: false, reason: lastError }
    } finally {
      running = false
    }
  }

  async function deliver(idea, label) {
    const text = buildApprovalMessage(idea, { projectsRoot: projectsRoot, templateRoot: templateRoot })
    const outcome = await deliverToAgent(ctx.get('agents'), text, { plugin: 'daily' })
    const record = {
      at: Date.now(),
      label: label,
      title: String(idea.title || ''),
      delivered: outcome.delivered === true,
      reason: outcome.reason === undefined ? '' : String(outcome.reason),
    }
    approvals.push(record)
    while (approvals.length > 50) approvals.shift()
    if (!record.delivered) pending.push({ idea: idea, label: label, text: text })
    try {
      if (ensureDir(dataDir)) appendFileSync(approvalsPath, JSON.stringify(record) + '\n')
    } catch (error) {
      // audit is best effort
    }
    saveState()
    return record
  }

  function ideaFor(payload) {
    const report = today !== undefined ? today : loadReport(dayKey(new Date()))
    if (report === undefined) return undefined
    if (typeof payload.title === 'string') {
      const idea = (report.ideas || []).find(function (item) { return item.title === payload.title })
      if (idea !== undefined) return { idea: Object.assign({ mode: 'build' }, idea), label: 'idea' }
    }
    if (typeof payload.repo === 'string') {
      const pick = (report.picks || []).find(function (item) { return item.repo === payload.repo })
      if (pick !== undefined) {
        return {
          label: 'pick',
          idea: {
            mode: 'reference',
            title: pick.name,
            oneLiner: pick.desc,
            gap: pick.why,
            evidence: pick.url,
            effort: '未知',
          },
        }
      }
    }
    return undefined
  }

  // An approval made while the session was busy stays queued and is retried the
  // moment a root agent appears, mirroring how a shipped reminder waits for a
  // live owner instead of being dropped.
  async function retryPending() {
    if (pending.length === 0) return
    const stillWaiting = []
    for (const item of pending) {
      const outcome = await deliverToAgent(ctx.get('agents'), item.text, { plugin: 'daily' })
      if (outcome.delivered === true) {
        const record = approvals.find(function (entry) { return entry.title === String(item.idea.title || '') && !entry.delivered })
        if (record !== undefined) {
          record.delivered = true
          record.reason = ''
        }
      } else {
        stillWaiting.push(item)
      }
    }
    pending.length = 0
    for (const item of stillWaiting) pending.push(item)
    saveState()
  }

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

  ctx.on('agent/created', function () {
    retryPending().then(function () {}, function () {})
  })

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
                  maxRecommend: cfg.maxRecommend,
                  maxIdeas: cfg.maxIdeas,
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
                  pending: pending.length,
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
              const found = ideaFor(body)
              if (found === undefined) {
                sendJson(res, 404, { error: 'unknown-approval-target' })
                return
              }
              const record = await deliver(found.idea, found.label)
              sendJson(res, 200, { ok: true, delivered: record.delivered, reason: record.reason, title: record.title })
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
