// Tests for the market catalog reader and the popularity signal.
//
// This module decides what the daily report is allowed to call "popular", so the
// rules that matter here are the ones about ABSENT data: a count the market did
// not publish must never become 0, a reply that is not a catalog must never
// become an empty-but-valid pool, and a failed refresh must fall back to the
// cache while saying so.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CACHE_FILE,
  CATALOG_URL,
  MAX_CACHE_AGE_MS,
  parseCatalog,
  popularityLabel,
  popularityScores,
  readCache,
  loadMarket,
  writeCache,
} from '../src/market.js'

/** A catalog document in the shape the live site publishes. */
function doc(items) {
  return { install: 'x', market: 'y', items: items }
}

function item(slug, extra) {
  return Object.assign({
    cat: 'ui',
    tag: 'UI Enhancements',
    dl: 10,
    stars: 3,
    added: '2026-08-14',
    name: slug.split('/')[1],
    owner: slug.split('/')[0],
    slug: slug,
    desc: 'Does a thing',
    npm: false,
    href: '/p/' + slug + '/',
  }, extra)
}

function tmpCachePath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-daily-market-')), CACHE_FILE)
}

/** A fetch double that records what it was asked for, when a recorder is given. */
function fetchOnce(response, calls) {
  return async function (url, options) {
    if (Array.isArray(calls)) calls.push({ url: url, options: options })
    if (response instanceof Error) throw response
    return response
  }
}

function ok(body) {
  return { status: 200, text: body }
}

// ---------------------------------------------------------------------------
// parseCatalog
// ---------------------------------------------------------------------------

test('a catalog item becomes an entry with its real counts', () => {
  const parsed = parseCatalog(doc([item('acme/dsh-thing', { dl: 1234, stars: 56 })]))
  assert.equal(parsed.entries.length, 1)
  const entry = parsed.entries[0]
  assert.equal(entry.repo, 'acme/dsh-thing')
  assert.equal(entry.url, 'https://github.com/acme/dsh-thing')
  assert.equal(entry.name, 'dsh-thing')
  assert.equal(entry.category, 'UI Enhancements', 'the human tag is what the prompt shows')
  assert.equal(entry.cat, 'ui', 'the id is kept too')
  assert.equal(entry.downloads, 1234)
  assert.equal(entry.stars, 56)
  assert.equal(parsed.newest, '2026-08-14')
})

test('an item with no slug falls back to owner/name', () => {
  const parsed = parseCatalog(doc([item('acme/dsh-thing', { slug: undefined })]))
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].repo, 'acme/dsh-thing')
})

test('an item with no usable repo is dropped, not defaulted', () => {
  const parsed = parseCatalog(doc([
    item('acme/dsh-thing'),
    { cat: 'ui', name: 'no-owner', tag: 'UI' },
    { cat: 'ui', name: '', owner: '', slug: '' },
    null,
    'not an object',
  ]))
  assert.equal(parsed.entries.length, 1, 'only the one identifiable item survives')
  assert.equal(parsed.dropped, 4)
})

test('a missing count stays undefined rather than becoming 0', () => {
  // 0 would claim "nobody downloaded this", which is a different statement from
  // "the market has no number for this" — and the report prints the difference.
  const parsed = parseCatalog(doc([
    item('acme/a', { dl: 0, stars: 0 }),
    item('acme/b', { dl: null }),
    item('acme/c', { dl: 'not a number', stars: -5 }),
  ]))
  assert.equal(parsed.entries[0].downloads, undefined, '0 downloads is not a usable popularity number')
  assert.equal(parsed.entries[0].stars, undefined)
  assert.equal(parsed.entries[1].downloads, undefined)
  assert.equal(parsed.entries[2].downloads, undefined)
  assert.equal(parsed.entries[2].stars, undefined)
  assert.equal(popularityLabel(parsed.entries[0]), '无热门度数据')
})

test('a non-document parses to nothing instead of throwing', () => {
  assert.deepEqual(parseCatalog(undefined).entries, [])
  assert.deepEqual(parseCatalog(null).entries, [])
  assert.deepEqual(parseCatalog({}).entries, [])
  assert.deepEqual(parseCatalog({ items: 'nope' }).entries, [])
})

test('descriptions are collapsed and truncated', () => {
  const long = 'x'.repeat(300)
  const parsed = parseCatalog(doc([item('acme/a', { desc: 'line one\n\n  line two ' }), item('acme/b', { desc: long })]))
  assert.equal(parsed.entries[0].desc, 'line one line two')
  assert.equal(parsed.entries[1].desc.length, 221, '220 chars plus the ellipsis')
  assert.ok(parsed.entries[1].desc.endsWith('…'))
})

test('newest and oldest read only well-formed dates', () => {
  const parsed = parseCatalog(doc([
    item('acme/a', { added: '2026-01-02' }),
    item('acme/b', { added: 'not a date' }),
    item('acme/c', { added: '2026-03-04' }),
  ]))
  assert.equal(parsed.oldest, '2026-01-02')
  assert.equal(parsed.newest, '2026-03-04')
})

// ---------------------------------------------------------------------------
// popularityScores
// ---------------------------------------------------------------------------

test('the most downloaded entry scores highest and the least downloaded nonzero', () => {
  const parsed = parseCatalog(doc([
    item('acme/low', { dl: 1 }),
    item('acme/high', { dl: 1000000 }),
    item('acme/mid', { dl: 5000 }),
  ]))
  const scores = popularityScores(parsed.entries)
  const by = (repo) => scores.get(parsed.entries.find((e) => e.repo === repo))
  assert.ok(by('acme/high') > by('acme/mid'), 'high > mid')
  assert.ok(by('acme/mid') > by('acme/low'), 'mid > low')
  assert.ok(by('acme/low') > 0, 'the least popular measured entry still outranks an unmeasured one')
})

test('a count the market did not publish cannot outrank a real one', () => {
  // The regression this pins: a first version scored a third "breadth" term that
  // counted which fields were present, which let an entry with 1 download outrank
  // one with 5,000 because the former happened to carry both counts.
  const parsed = parseCatalog(doc([
    item('acme/tiny-but-complete', { dl: 1, stars: 1 }),
    item('acme/big-but-no-stars', { dl: 5000, stars: 0 }),
  ]))
  const scores = popularityScores(parsed.entries)
  const tiny = parsed.entries[0]
  const big = parsed.entries[1]
  assert.ok(scores.get(big) > scores.get(tiny), 'downloads decide, not field presence')
})

test('an entry with no numbers scores below every measured entry', () => {
  const parsed = parseCatalog(doc([item('acme/measured', { dl: 1, stars: 0 }), item('acme/blank', { dl: 0, stars: 0 })]))
  const scores = popularityScores(parsed.entries)
  const measured = parsed.entries[0]
  const blank = parsed.entries[1]
  assert.ok(scores.get(measured) > scores.get(blank))
  // Two entries: the better-ranked one gets 2/2, the other 1/2. Every entry gets
  // a score, so an unmeasured one still loses to a measured one.
  assert.equal(scores.get(measured), 1)
  assert.equal(scores.get(blank), 0.5)
})

test('stars only ever break ties on equal downloads', () => {
  const parsed = parseCatalog(doc([
    item('acme/few-downloads-many-stars', { dl: 1, stars: 84099 }),
    item('acme/many-downloads-no-stars', { dl: 5000, stars: 0 }),
  ]))
  const scores = popularityScores(parsed.entries)
  const few = parsed.entries[0]
  const many = parsed.entries[1]
  assert.ok(scores.get(many) > scores.get(few), '5000 downloads beats 1 download with any star count')
})

test('equal downloads are ordered by stars', () => {
  const parsed = parseCatalog(doc([
    item('acme/low-stars', { dl: 100, stars: 1 }),
    item('acme/high-stars', { dl: 100, stars: 900 }),
  ]))
  const scores = popularityScores(parsed.entries)
  assert.ok(scores.get(parsed.entries[1]) > scores.get(parsed.entries[0]))
})

test('scores are bounded and every entry gets one', () => {
  const entries = parseCatalog(doc([
    item('acme/a', { dl: 5, stars: 5 }),
    item('acme/b', { dl: 9, stars: 9 }),
    item('acme/c', { dl: 0, stars: 0 }),
  ])).entries
  const scores = popularityScores(entries)
  assert.equal(scores.size, 3)
  for (const entry of entries) {
    const score = scores.get(entry)
    assert.ok(score >= 0 && score <= 1, 'score in 0..1, got ' + score)
  }
})

test('popularityScores tolerates junk input', () => {
  assert.equal(popularityScores(undefined).size, 0)
  assert.equal(popularityScores([]).size, 0)
  assert.equal(popularityScores([null, undefined, 3]).size, 0)
})

test('popularityLabel prints only the numbers that exist', () => {
  assert.equal(popularityLabel({ downloads: 1500, stars: 12 }), '1,500 次下载 · 12★')
  assert.equal(popularityLabel({ downloads: 1500 }), '1,500 次下载')
  assert.equal(popularityLabel({ stars: 12 }), '12★')
  assert.equal(popularityLabel({}), '无热门度数据')
  assert.equal(popularityLabel(null), '无热门度数据')
})

// ---------------------------------------------------------------------------
// cache and HTTP
// ---------------------------------------------------------------------------

test('a fresh cache is used without touching the network', async () => {
  const cachePath = tmpCachePath()
  const entries = parseCatalog(doc([item('acme/cached', { dl: 7 })])).entries
  writeCache(cachePath, { fetchedAt: Date.now(), source: CATALOG_URL, sourceDate: '2026-08-14', entries: entries })
  const calls = []
  const result = await loadMarket({
    cachePath: cachePath,
    fetchImpl: fetchOnce(ok('{}'), calls),
  })
  assert.equal(calls.length, 0, 'a cache younger than the max age must not be refetched')
  assert.equal(result.meta.status, 'cache')
  assert.equal(result.entries.length, 1)
  assert.equal(result.meta.sourceDate, '2026-08-14')
})

test('a stale cache is refetched and the new document is cached', async () => {
  const cachePath = tmpCachePath()
  const stale = Date.now() - MAX_CACHE_AGE_MS - 60000
  const old = parseCatalog(doc([item('acme/old', { dl: 1 })])).entries
  writeCache(cachePath, { fetchedAt: stale, attemptedAt: stale, source: CATALOG_URL, sourceDate: '2026-01-01', entries: old })
  const body = JSON.stringify(doc([item('acme/new', { dl: 999, added: '2026-10-15' })]))
  const calls = []
  const result = await loadMarket({ cachePath: cachePath, fetchImpl: fetchOnce(ok(body), calls) })
  assert.equal(calls.length, 1)
  assert.equal(result.meta.status, 'fresh')
  assert.equal(result.entries[0].repo, 'acme/new')
  assert.equal(result.meta.sourceDate, '2026-10-15')
  const written = readCache(cachePath)
  assert.equal(written.entries[0].repo, 'acme/new', 'the fresh document replaces the cache')
  assert.equal(written.sourceDate, '2026-10-15')
})

test('force ignores a fresh cache', async () => {
  const cachePath = tmpCachePath()
  writeCache(cachePath, {
    fetchedAt: Date.now(), source: CATALOG_URL, sourceDate: '2026-01-01',
    entries: parseCatalog(doc([item('acme/old')])).entries,
  })
  const calls = []
  const result = await loadMarket({
    cachePath: cachePath, force: true,
    fetchImpl: fetchOnce(ok(JSON.stringify(doc([item('acme/new')]))), calls),
  })
  assert.equal(calls.length, 1)
  assert.equal(result.entries[0].repo, 'acme/new')
})

test('a failed refresh falls back to the cache and says the data is stale', async () => {
  const cachePath = tmpCachePath()
  const fetchedAt = Date.now() - MAX_CACHE_AGE_MS - 60000
  writeCache(cachePath, {
    fetchedAt: fetchedAt, attemptedAt: fetchedAt, source: CATALOG_URL, sourceDate: '2026-08-14',
    entries: parseCatalog(doc([item('acme/cached', { dl: 7 })])).entries,
  })
  const result = await loadMarket({
    cachePath: cachePath,
    fetchImpl: fetchOnce(new Error('getaddrinfo ENOTFOUND awesome-dsh-plugin.com')),
  })
  assert.equal(result.meta.status, 'stale')
  assert.equal(result.entries.length, 1, 'the report still has last-known-real numbers')
  assert.match(result.meta.warning, /刷新失败/)
  assert.match(result.meta.warning, /ENOTFOUND/)
  assert.equal(result.meta.sourceDate, '2026-08-14', 'the honest data date travels with the fallback')
  // The failure is remembered without pretending the data was refreshed.
  const written = readCache(cachePath)
  assert.equal(written.fetchedAt, fetchedAt, 'a failed attempt must not move fetchedAt')
  assert.ok(written.attemptedAt > fetchedAt, 'a failed attempt is recorded')
})

test('a recent failure does not retry on every call', async () => {
  const cachePath = tmpCachePath()
  const stale = Date.now() - MAX_CACHE_AGE_MS - 60000
  writeCache(cachePath, {
    fetchedAt: stale, attemptedAt: stale, source: CATALOG_URL, sourceDate: '2026-08-14',
    entries: parseCatalog(doc([item('acme/cached')])).entries,
  })
  const failing = fetchOnce(new Error('offline'))
  const first = await loadMarket({ cachePath: cachePath, fetchImpl: failing })
  assert.equal(first.meta.status, 'stale')
  const calls = []
  const second = await loadMarket({ cachePath: cachePath, fetchImpl: fetchOnce(ok('{}'), calls) })
  assert.equal(calls.length, 0, 'inside the retry window the cache is served without a socket')
  assert.equal(second.meta.status, 'stale')
})

test('no cache and no network yields no entries and a warning', async () => {
  const result = await loadMarket({
    cachePath: tmpCachePath(),
    fetchImpl: fetchOnce(new Error('offline')),
  })
  assert.deepEqual(result.entries, [])
  assert.equal(result.meta.status, 'unavailable')
  assert.match(result.meta.warning, /不可用/)
})

test('a reply that is not a catalog is refused', async () => {
  for (const body of ['not json at all', '{"items":[]}', '{"items":"nope"}', '[]', '{"other":1}']) {
    const result = await loadMarket({
      cachePath: tmpCachePath(),
      fetchImpl: fetchOnce(ok(body)),
    })
    assert.deepEqual(result.entries, [], 'body ' + JSON.stringify(body) + ' must not become a pool')
    assert.equal(result.meta.status, 'unavailable')
  }
})

test('a non-200 reply is refused', async () => {
  const result = await loadMarket({
    cachePath: tmpCachePath(),
    fetchImpl: fetchOnce({ status: 502, text: '<html>bad gateway</html>' }),
  })
  assert.deepEqual(result.entries, [])
  assert.match(result.meta.warning, /HTTP 502/)
})

test('only https from the named hosts is fetched', async () => {
  for (const url of ['http://awesome-dsh-plugin.com/catalog.json', 'https://evil.example.com/catalog.json', 'file:///c:/x.json']) {
    const calls = []
    const result = await loadMarket({
      cachePath: tmpCachePath(),
      url: url,
      fetchImpl: fetchOnce(ok(JSON.stringify(doc([item('acme/a')]))), calls),
    })
    assert.equal(calls.length, 0, url + ' must never be requested')
    assert.deepEqual(result.entries, [])
  }
})

test('an oversized reply is refused before it is parsed', () => {
  // Exercised through readUrl's cap: 17 MB of body, which is above the limit.
  const huge = 'x'.repeat(17 * 1024 * 1024)
  return loadMarket({
    cachePath: tmpCachePath(),
    fetchImpl: fetchOnce(ok(huge)),
  }).then(function (result) {
    assert.deepEqual(result.entries, [])
  })
})

test('a corrupt cache file is ignored rather than trusted', async () => {
  const cachePath = tmpCachePath()
  writeFileSync(cachePath, '{ this is not json')
  assert.equal(readCache(cachePath), undefined)
  const result = await loadMarket({
    cachePath: cachePath,
    fetchImpl: fetchOnce(ok(JSON.stringify(doc([item('acme/a', { dl: 3 })])))),
  })
  assert.equal(result.meta.status, 'fresh')
  assert.equal(result.entries.length, 1)
})

test('a cache with no entries is treated as no cache', () => {
  const cachePath = tmpCachePath()
  writeCache(cachePath, { fetchedAt: Date.now(), source: CATALOG_URL, sourceDate: '', entries: [] })
  assert.equal(readCache(cachePath), undefined)
})

test('the cached document keeps only the fields the report reads', async () => {
  const cachePath = tmpCachePath()
  await loadMarket({
    cachePath: cachePath,
    fetchImpl: fetchOnce(ok(JSON.stringify(doc([item('acme/a', { href: '/p/acme/a/', cmd: 'dsh plugin add a' })])))),
  })
  const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
  assert.deepEqual(Object.keys(raw.entries[0]).sort(), [
    'added', 'cat', 'category', 'desc', 'downloads', 'name', 'npm', 'repo', 'stars', 'url',
  ])
})