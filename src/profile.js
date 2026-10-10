// Builds the "who is this for" brief that the daily report is ranked against.
//
// This module deliberately does NOT invent interest keywords by mining prose.
// Scoring prose against plugin descriptions is the kind of fuzzy heuristic that
// looks clever and produces confident nonsense. Instead it collects the three
// things that are actually verifiable about the user — what they wrote down
// about themselves, what conventions they work under, and which plugins they
// already run — and hands that compactly to the model, which is better at
// reading it than a regex is.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_BUDGETS = { memory: 4000, conventions: 2500 }

/** Trim to a budget on a line boundary where possible, and say so when cut. */
export function truncateForPrompt(text, max) {
  if (typeof text !== 'string') return ''
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const lastBreak = cut.lastIndexOf('\n')
  const body = lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut
  return body + '\n…（已截断，原文 ' + clean.length + ' 字符）'
}

/**
 * Bundle and dependency names from a profile's package.json.
 * Returns [] for missing or malformed input rather than throwing: an unreadable
 * profile must degrade the brief, never break the daily run.
 */
export function installedBundleNames(profileJsonText) {
  if (typeof profileJsonText !== 'string' || profileJsonText.length === 0) return []
  let parsed
  try {
    parsed = JSON.parse(profileJsonText)
  } catch (error) {
    return []
  }
  const names = []
  const dependencies = parsed && parsed.dependencies
  if (dependencies && typeof dependencies === 'object') {
    for (const key of Object.keys(dependencies)) names.push(key)
  }
  const bundles = parsed && parsed.dsh && parsed.dsh.profile && parsed.dsh.profile.bundles
  if (Array.isArray(bundles)) {
    for (const bundle of bundles) {
      if (typeof bundle === 'string' && names.indexOf(bundle) < 0) names.push(bundle)
    }
  }
  return names.sort()
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    return undefined
  }
}

/**
 * Read the profile sources from disk. Anything missing is reported in `missing`
 * instead of silently vanishing, so a half-configured machine is visible in the
 * report rather than producing a mysteriously generic brief.
 */
export function loadProfileSources(options) {
  const settings = options || {}
  const dshHome = String(settings.dshHome || '')
  const codexHome = String(settings.codexHome || '')
  const profileName = String(settings.profileName || 'desktop')

  const probes = [
    { kind: 'memory', label: '记忆画像', path: join(codexHome, 'memories', 'memory_summary.md') },
    { kind: 'conventions', label: '工作约定', path: join(dshHome, 'AGENTS.md') },
  ]

  const sources = []
  const missing = []
  for (const probe of probes) {
    const text = readText(probe.path)
    if (text === undefined) missing.push(probe.label + '（' + probe.path + '）')
    else sources.push({ kind: probe.kind, label: probe.label, path: probe.path, text: text })
  }

  const profilePath = join(dshHome, 'profiles', profileName, 'package.json')
  const profileText = readText(profilePath)
  const installed = installedBundleNames(profileText)
  if (installed.length === 0) missing.push('已装插件清单（' + profilePath + '）')

  return { sources: sources, installed: installed, missing: missing, profilePath: profilePath }
}

/**
 * Assemble the brief. Pure: everything it needs is in `input`.
 * @param {{sources: Array<{kind:string,label:string,path:string,text:string}>, installed: string[], missing: string[]}} input
 * @param {{memory?:number, conventions?:number}} [budgets]
 */
export function buildProfileBrief(input, budgets) {
  const limits = Object.assign({}, DEFAULT_BUDGETS, budgets || {})
  const sources = (input && input.sources) || []
  const installed = (input && input.installed) || []
  const missing = (input && input.missing) || []

  const lines = []
  lines.push('## 这位用户是谁')
  lines.push('')

  const memory = sources.find(function (source) { return source.kind === 'memory' })
  if (memory !== undefined) {
    lines.push('### ' + memory.label)
    lines.push(truncateForPrompt(memory.text, limits.memory))
    lines.push('')
  }

  const conventions = sources.find(function (source) { return source.kind === 'conventions' })
  if (conventions !== undefined) {
    lines.push('### ' + conventions.label)
    lines.push(truncateForPrompt(conventions.text, limits.conventions))
    lines.push('')
  }

  lines.push('### 已经在跑的插件（不要推荐这些）')
  lines.push(installed.length > 0 ? installed.map(function (name) { return '- ' + name }).join('\n') : '（读不到）')
  lines.push('')

  if (missing.length > 0) {
    lines.push('### 读不到的画像来源（据此降低你的确信度）')
    lines.push(missing.map(function (item) { return '- ' + item }).join('\n'))
    lines.push('')
  }

  return lines.join('\n').trim()
}
