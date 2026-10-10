import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildProfileBrief,
  installedBundleNames,
  loadProfileSources,
  truncateForPrompt,
} from '../src/profile.js'

test('truncateForPrompt leaves short text alone', () => {
  assert.equal(truncateForPrompt('  hello  ', 100), 'hello')
  assert.equal(truncateForPrompt('a\r\nb', 100), 'a\nb')
})

test('truncateForPrompt cuts long text and says how long it was', () => {
  const text = 'x'.repeat(500)
  const out = truncateForPrompt(text, 100)
  assert.ok(out.startsWith('x'.repeat(100)))
  assert.ok(out.includes('已截断'))
  assert.ok(out.includes('500'))
})

test('truncateForPrompt prefers to cut on a line boundary', () => {
  const text = 'aaaa\nbbbb\ncccc\ndddd'
  const out = truncateForPrompt(text, 12)
  assert.ok(out.startsWith('aaaa\nbbbb\n…'), 'got: ' + JSON.stringify(out))
})

test('truncateForPrompt tolerates non-strings', () => {
  for (const value of [undefined, null, 42, {}]) {
    assert.equal(truncateForPrompt(value, 10), '')
  }
})

test('installedBundleNames merges dependencies and bundles, deduped and sorted', () => {
  const json = JSON.stringify({
    dependencies: { 'dsh-warden': 'link:x', 'dsh-holdem': 'link:y' },
    dsh: { profile: { bundles: ['dsh-holdem', '@deepseek-ai/dsh-base', 'dshmarket'] } },
  })
  assert.deepEqual(installedBundleNames(json), [
    '@deepseek-ai/dsh-base',
    'dsh-holdem',
    'dsh-warden',
    'dshmarket',
  ])
})

test('installedBundleNames degrades to empty on bad input', () => {
  assert.deepEqual(installedBundleNames('{not json'), [])
  assert.deepEqual(installedBundleNames(''), [])
  assert.deepEqual(installedBundleNames(undefined), [])
  assert.deepEqual(installedBundleNames('{}'), [])
})

test('buildProfileBrief carries the profile, the conventions and the installed list', () => {
  const brief = buildProfileBrief({
    sources: [
      { kind: 'memory', label: '记忆画像', path: 'p1', text: '用户喜欢自动化与安全审查' },
      { kind: 'conventions', label: '工作约定', path: 'p2', text: '先选路径再动手' },
    ],
    installed: ['dsh-warden'],
    missing: [],
  })
  assert.ok(brief.includes('记忆画像'))
  assert.ok(brief.includes('用户喜欢自动化与安全审查'))
  assert.ok(brief.includes('工作约定'))
  assert.ok(brief.includes('先选路径再动手'))
  assert.ok(brief.includes('dsh-warden'))
  assert.ok(brief.includes('不要推荐这些'))
})

test('buildProfileBrief surfaces unreadable sources instead of hiding them', () => {
  const brief = buildProfileBrief({ sources: [], installed: [], missing: ['记忆画像（C:\\nope）'] })
  assert.ok(brief.includes('读不到的画像来源'))
  assert.ok(brief.includes('C:\\nope'))
  assert.ok(brief.includes('（读不到）'))
})

test('buildProfileBrief tolerates completely empty input', () => {
  const brief = buildProfileBrief(undefined)
  assert.equal(typeof brief, 'string')
  assert.ok(brief.includes('这位用户是谁'))
})

test('loadProfileSources reports a machine with nothing configured as missing, not as an error', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-daily-profile-'))
  const result = loadProfileSources({ dshHome: home, codexHome: home, profileName: 'desktop' })
  assert.deepEqual(result.sources, [])
  assert.deepEqual(result.installed, [])
  assert.equal(result.missing.length, 3)
})

test('loadProfileSources picks up a real profile directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-daily-profile-'))
  mkdirSync(join(home, 'memories'), { recursive: true })
  writeFileSync(join(home, 'memories', 'memory_summary.md'), '画像内容')
  writeFileSync(join(home, 'AGENTS.md'), '约定内容')
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(
    join(home, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-warden': 'link:x' } }),
  )
  const result = loadProfileSources({ dshHome: home, codexHome: home, profileName: 'desktop' })
  assert.equal(result.sources.length, 2)
  assert.deepEqual(result.installed, ['dsh-warden'])
  assert.deepEqual(result.missing, [])
})
