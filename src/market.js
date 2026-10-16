// The plugin market as a data source, and the popularity signal it carries.
//
// Why this module exists
// ---------------------
// The daily report used to read a CSV snapshot of the ecosystem taken on
// 2026-09-17, and it had no popularity signal at all: the prompt literally
// forbade the model from mentioning star counts or download counts, because
// there were none to mention. So every candidate in a category was as likely to
// be picked as any other — the shortlist was decided by CSV row order.
//
// The user's ask (2026-10-15): the report should be driven by what the market
// actually shows to be popular, so the "improve on someone else's work" half
// targets plugins that people really install.
//
// What the market publishes
// -------------------------
// `https://awesome-dsh-plugin.com/catalog.json` is the document the in-app
// market itself reads. One GET returns every listed plugin with its
// description, category, star count, download count and the date it was added.
// Measured 2026-10-15: 4,765 items across 23 categories, last item added that
// same day; 2,444 items carry a download count and 3,723 a star count.
//
// That is strictly better than the two raw JSON files in the repository
// (`data/stars.json`, `data/downloads.json`), whose `checkedAt` stamps are all
// 2026-08-19 — a month stale — and which carry no description or category.
//
// Shapes, kept deliberately loose
// ------------------------------
// This reads a third party's document, so every field is treated as optional:
// an item without a usable repo URL is dropped rather than defaulted, a missing
// count is `undefined` rather than 0 (0 would claim "nobody downloaded this",
// which is a different and false statement), and an unrecognised category is
// kept as its raw string instead of being mapped onto a guess.
//
// Nothing here fetches. `parseCatalog` and `popularityScores` are pure so they
// are unit-testable without a network; the host owns the HTTP and the cache.

import { readFileSync, writeFileSync } from 'node:fs';

const MAX_DESC = 220;

/** A repo identity comparable across the catalog and any other source. */
export function normaliseRepo(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().toLowerCase().replace(/\/+$/, '');
}

/** One line, collapsed and truncated for a prompt row. */
export function oneLine(text, max) {
  const limit = Number.isInteger(max) && max > 0 ? max : MAX_DESC;
  const flat = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

/** A positive finite count, or undefined. Never 0-by-default: absent ≠ zero. */
function countOf(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Turn one catalog document into entries the report layer understands.
 *
 * Returns the entries plus the metadata the caller must surface: the newest
 * `added` date in the document (evidence of how current it is) and how many
 * items were dropped for lacking a usable identity.
 *
 * @param {unknown} document parsed catalog.json
 * @returns {{entries:object[], dropped:number, newest:string, oldest:string}}
 */
export function parseCatalog(document) {
  const doc = document !== null && typeof document === 'object' ? document : {};
  const rawItems = Array.isArray(doc.items) ? doc.items : [];
  const entries = [];
  let dropped = 0;

  for (const item of rawItems) {
    if (item === null || typeof item !== 'object') {
      dropped += 1;
      continue;
    }
    // `slug` is "owner/repo"; `href` is the site-relative page. Either can build
    // the identity, and the URL form is what the rest of the plugin compares on.
    const slug = String(item.slug === undefined || item.slug === null ? '' : item.slug).trim();
    const name = String(item.name === undefined || item.name === null ? '' : item.name).trim();
    const owner = String(item.owner === undefined || item.owner === null ? '' : item.owner).trim();
    const repo = normaliseRepo(slug !== '' ? slug : owner !== '' && name !== '' ? `${owner}/${name}` : '');
    if (repo === '') {
      dropped += 1;
      continue;
    }
    const url = 'https://github.com/' + repo;
    entries.push({
      category: String(item.tag !== undefined && item.tag !== null && String(item.tag).trim() !== '' ? item.tag : item.cat || ''),
      cat: String(item.cat === undefined || item.cat === null ? '' : item.cat),
      name: name !== '' ? name : repo,
      repo: repo,
      url: url,
      desc: oneLine(item.desc),
      // Popularity: undefined when the market has no number. The distinction is
      // load-bearing — see the note at the top of this file.
      downloads: countOf(item.dl),
      stars: countOf(item.stars),
      npm: item.npm === true || item.npm === 1,
      added: String(item.added === undefined || item.added === null ? '' : item.added),
    });
  }

  const dates = entries.map((e) => e.added).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return {
    entries: entries,
    dropped: dropped,
    newest: dates.length > 0 ? dates[dates.length - 1] : '',
    oldest: dates.length > 0 ? dates[0] : '',
  };
}

/**
 * Popularity score in 0..1 for every entry: downloads lead, stars break ties.
 *
 * Why the two signals are ranked TOGETHER rather than added as two independent
 * rank terms — this is the second version of this function, and the first one
 * was wrong. Adding `0.65 * rank(downloads) + 0.35 * rank(stars)` lets the star
 * term outvote downloads whenever the star counts are equal or absent, which is
 * common: a test with three entries all carrying 3 stars had the star ranking
 * fall back to document order and push a 5,000-download entry below a
 * 1-download one. Ranking by (downloads, then stars) makes the priority explicit
 * and leaves the secondary signal unable to invert the primary one.
 *
 * Downloads lead because they measure the thing this report cares about —
 * someone actually installed the plugin — while stars measure approval. Stars
 * cover more of the catalog (3,723 items vs 2,444 for downloads), so they still
 * order the entries the market has not measured downloads for.
 *
 * A missing number sorts last within its group rather than being treated as 0.
 * A first version also scored a third "breadth" term (which optional fields are
 * present); measured against the live catalog it was not inert — 4,765 items
 * carry breadth 2/3/4 — and it correlated with nothing but "has both counts",
 * so it was removed rather than kept as decoration.
 *
 * The pool matters, so the caller must pass the whole candidate pool rather than
 * a pre-sliced page — a rank computed inside one category of two items would
 * declare one of them "the most popular plugin in the ecosystem".
 *
 * @param {object[]} entries
 * @returns {Map<object, number>}
 */
export function popularityScores(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e !== null && typeof e === 'object') : [];
  const scores = new Map();
  if (list.length === 0) return scores;

  const value = (entry, key) => {
    const n = entry[key];
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
  };
  // Downloads first, stars only to separate equal downloads; absent numbers sort
  // below present ones at every level.
  const ranked = list.slice().sort((a, b) => {
    const ad = value(a, 'downloads');
    const bd = value(b, 'downloads');
    if (ad !== bd) {
      if (ad === undefined) return 1;
      if (bd === undefined) return -1;
      return bd - ad;
    }
    const as = value(a, 'stars');
    const bs = value(b, 'stars');
    if (as === bs) return 0;
    if (as === undefined) return 1;
    if (bs === undefined) return -1;
    return bs - as;
  });

  const total = ranked.length;
  for (let i = 0; i < total; i += 1) {
    // Best 1, worst 1/n. Every entry in the pool gets a positive score, so an
    // entry the market did not measure still loses to one it did.
    scores.set(ranked[i], (total - i) / total);
  }
  return scores;
}

/**
 * The evidence line for one entry, for the report and the panel.
 *
 * A missing number is reported as missing. Printing "0 次下载" for a plugin the
 * market simply has not measured would be a fabricated fact, and the whole point
 * of this feature is that the numbers in the report are real.
 */
export function popularityLabel(entry) {
  if (entry === null || typeof entry !== 'object') return '无热门度数据';
  const parts = [];
  if (typeof entry.downloads === 'number') parts.push(entry.downloads.toLocaleString('en-US') + ' 次下载');
  if (typeof entry.stars === 'number') parts.push(entry.stars.toLocaleString('en-US') + '★');
  if (parts.length === 0) return '无热门度数据';
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Cache and HTTP. Everything below touches disk, the clock or the network, so it
// is separated from the pure half above and takes its side effects by injection.
// This plugin's other modules degrade rather than throw (`loadCorpus` returns
// [] on a missing file); the same rule applies here, because a daily report
// with no popularity data is still a report, while a thrown error is no report
// at all.
// ---------------------------------------------------------------------------

/** Where the market itself publishes the document its own UI reads. */
export const CATALOG_URL = 'https://awesome-dsh-plugin.com/catalog.json';

export const CACHE_FILE = 'market-cache.json';

/**
 * A catalog older than this is refetched even if the last attempt succeeded.
 * One day matches the report's own cadence: there is nothing to gain from a
 * fresher pool than the report it feeds.
 */
export const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * After a FAILED refresh, do not try again for this long. A machine that is
 * offline all morning should not pay a connection timeout on every panel poll.
 *
 * This is a separate clock from `fetchedAt`: a failure has to be remembered
 * without pretending the data was just refreshed, or the next call would either
 * hammer the network or believe the cache is new.
 */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

/** The document is ~2.6 MB today; this leaves generous headroom and still bounds a hostile reply. */
const MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;

/** Only HTTPS, and only from the host we name plus GitHub's raw host. */
const ALLOWED_HOSTS = new Set(['awesome-dsh-plugin.com', 'raw.githubusercontent.com']);

function httpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The body as text, from either a real fetch Response or the plain object the
 * tests inject.
 *
 * A real fetch gives `text()` as a METHOD (an unawaited one stringifies to
 * "function"), while the test double gives a plain `text` string. Accepting only
 * one of the two is how the first live run reported "no body text" against a
 * perfectly healthy catalog — so both are read, and a Response is awaited.
 *
 * @returns {Promise<string>}
 */
async function bodyText(response) {
  if (typeof response.text === 'string') return response.text;
  if (typeof response.text === 'function') {
    const text = await response.text();
    return typeof text === 'string' ? text : '';
  }
  return '';
}

/** Shape check shared by `fetchImpl` and real fetch. */
async function assertResponse(response) {
  if (response === null || typeof response !== 'object') throw httpError('bad-response', 'no response object');
  if (typeof response.status !== 'number') throw httpError('bad-response', 'no status code');
  return response;
}

async function readUrl(url, timeoutMs, signal, fetchImpl) {
  // The injected implementation is for tests only; production uses whatever the
  // runtime provides as global fetch. Reading it here rather than at module load
  // keeps import side-effect free and makes an Electron or an older Node without
  // global fetch degrade to "no popularity data" instead of failing to load.
  const doFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined);
  if (typeof doFetch !== 'function') throw httpError('no-fetch', 'this runtime has no fetch');

  let parsed
  try {
    parsed = new URL(url)
  } catch (error) {
    throw httpError('bad-url', url)
  }
  if (parsed.protocol !== 'https:') throw httpError('bad-url', 'only https is allowed: ' + url)
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw httpError('bad-url', 'host not allowed: ' + parsed.hostname)

  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  let onAbort
  if (controller !== undefined) {
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) throw httpError('aborted', 'aborted before the request started')
      onAbort = function () { controller.abort() }
      signal.addEventListener('abort', onAbort)
    }
  }
  const timer = setTimeout(function () {
    if (controller !== undefined) controller.abort()
  }, Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS)

  try {
    const response = await assertResponse(await doFetch(url, {
      signal: controller === undefined ? signal : controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'dsh-daily' },
    }))
    if (response.status !== 200) throw httpError('http-' + response.status, 'HTTP ' + response.status)
    const text = await bodyText(response)
    if (text.length > MAX_BYTES) throw httpError('too-large', 'response over ' + MAX_BYTES + ' bytes')
    return { status: response.status, headers: response.headers, text: text }
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined && signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Parse a JSON document, refusing anything that is not shaped like a catalog.
 * A truncated reply is valid JSON only by accident; requiring a non-empty
 * `items` array means a half-written cache cannot masquerade as a real one.
 */
function parseDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw httpError('bad-json', 'catalog is not JSON')
  }
  const items = parsed !== null && typeof parsed === 'object' ? parsed.items : undefined
  if (!Array.isArray(items) || items.length === 0) throw httpError('bad-shape', 'catalog has no items');
  return parsed
}

/** Read the cache file. Returns undefined for anything unusable — never throws. */
export function readCache(cachePath) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined;
    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return undefined;
    return {
      fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      attemptedAt: typeof parsed.attemptedAt === 'number' ? parsed.attemptedAt : (typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0),
      source: typeof parsed.source === 'string' ? parsed.source : '',
      sourceDate: typeof parsed.sourceDate === 'string' ? parsed.sourceDate : '',
      entries: parsed.entries,
    };
  } catch (error) {
    return undefined;
  }
}

/** Write the cache. Best effort: a failed write must not fail the report run. */
export function writeCache(cachePath, payload) {
  try {
    writeFileSync(cachePath, JSON.stringify(payload));
    return true;
  } catch (error) {
    return false;
  }
}

function summarise(entries, now) {
  let withDownloads = 0;
  let withStars = 0;
  for (const entry of entries) {
    if (typeof entry.downloads === 'number') withDownloads += 1;
    if (typeof entry.stars === 'number') withStars += 1;
  }
  return {
    total: entries.length,
    withDownloads: withDownloads,
    withStars: withStars,
    fetchedAt: now,
  };
}

/**
 * The market catalog, preferring the cache and refreshing it at most once a day.
 *
 * Never throws, and never returns entries it did not get from somewhere real.
 * `meta` is what the caller must show the user:
 *
 *   status     'fresh' (network) | 'cache' (fresh enough) | 'stale' (network failed)
 *   sourceDate newest `added` date inside the document — the honest answer to
 *              "how old is this data", not the time we downloaded it
 *   ageMs      how long ago the data was fetched
 *   warning    one line to put in front of the user when something is wrong
 *
 * @param {{cachePath:string, url?:string, now?:number, fetchImpl?:Function,
 *   signal?:AbortSignal|null, timeoutMs?:number, force?:boolean}} options
 * @returns {Promise<{entries:object[], meta:object}>}
 */
export async function loadMarket(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const url = typeof opts.url === 'string' && opts.url !== '' ? opts.url : CATALOG_URL;
  const cachePath = typeof opts.cachePath === 'string' ? opts.cachePath : '';
  const cached = cachePath === '' ? undefined : readCache(cachePath);
  const age = cached === undefined ? Infinity : now - (cached.fetchedAt || 0);
  // A failed attempt is remembered so an offline morning costs one timeout, not
  // one per poll.
  const sinceAttempt = cached === undefined ? Infinity : now - (cached.attemptedAt || 0);

  if (opts.force !== true && cached !== undefined) {
    if (age < MAX_CACHE_AGE_MS) {
      return { entries: cached.entries, meta: Object.assign(summarise(cached.entries, cached.fetchedAt), {
        status: 'cache', source: cached.source || url, sourceDate: cached.sourceDate || '', ageMs: age, warning: '',
      }) };
    }
    if (sinceAttempt < RETRY_AFTER_MS) {
      return { entries: cached.entries, meta: Object.assign(summarise(cached.entries, cached.fetchedAt), {
        status: 'stale', source: cached.source || url, sourceDate: cached.sourceDate || '', ageMs: age,
        warning: '热门度数据没能刷新（上次成功是 ' + Math.round(age / 3600000) + ' 小时前），用的是缓存的旧数字',
      }) };
    }
  }

  try {
    const response = await readUrl(url, opts.timeoutMs, opts.signal, opts.fetchImpl);
    const document = parseDocument(response.text);
    const parsed = parseCatalog(document);
    if (parsed.entries.length === 0) throw httpError('empty', 'catalog parsed to zero usable entries');
    if (cachePath !== '') {
      writeCache(cachePath, {
        fetchedAt: now, attemptedAt: now, source: url, sourceDate: parsed.newest,
        // Only the fields the report needs, so the cache stays small and a
        // future field added upstream cannot silently change behaviour.
        entries: parsed.entries.map(function (entry) {
          return {
            category: entry.category, cat: entry.cat, name: entry.name, repo: entry.repo,
            url: entry.url, desc: entry.desc, downloads: entry.downloads, stars: entry.stars,
            npm: entry.npm, added: entry.added,
          };
        }),
      });
    }
    return { entries: parsed.entries, meta: Object.assign(summarise(parsed.entries, now), {
      status: 'fresh', source: url, sourceDate: parsed.newest, ageMs: 0, dropped: parsed.dropped, warning: '',
    }) };
  } catch (error) {
    // Remember the failure without claiming a refresh: `fetchedAt` stays where
    // it was, so `sourceDate` and `ageMs` keep telling the truth.
    if (cached !== undefined && cachePath !== '') {
      writeCache(cachePath, {
        fetchedAt: cached.fetchedAt, attemptedAt: now, source: cached.source || url,
        sourceDate: cached.sourceDate || '', entries: cached.entries,
      });
    }
    if (cached !== undefined) {
      return { entries: cached.entries, meta: Object.assign(summarise(cached.entries, cached.fetchedAt), {
        status: 'stale', source: cached.source || url, sourceDate: cached.sourceDate || '', ageMs: age,
        warning: '热门度数据刷新失败（' + String(error && error.message ? error.message : error) + '），用的是缓存的数据',
      }) };
    }
    return { entries: [], meta: {
      status: 'unavailable', source: url, sourceDate: '', ageMs: 0, total: 0, withDownloads: 0, withStars: 0,
      warning: '热门度数据不可用（' + String(error && error.message ? error.message : error) + '），本次日报没有热度排序',
    } };
  }
}
