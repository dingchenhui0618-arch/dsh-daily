/**
 * Deterministic shortlist selection for the dsh-daily plugin survey.
 *
 * Pure: same input, same output. No randomness, no Date, no I/O, and neither the
 * input array nor any entry object is mutated.
 */

const DEFAULT_MAX = 60;
const DEFAULT_PER_CATEGORY = 2;

/** trim + lowercase, tolerating non-strings. */
function normalise(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().toLowerCase();
}

/** Normalise a list of names into a lookup Set (ignoring empty values). */
function toLookup(values) {
  const set = new Set();
  if (!Array.isArray(values)) return set;
  for (const value of values) {
    const key = normalise(value);
    if (key !== '') set.add(key);
  }
  return set;
}

/** Positive-integer option, otherwise the supplied default. */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Deterministically pick a balanced shortlist of candidates.
 *
 * @param {object[]} entries
 * @param {{
 *   installed?: string[],   // bundle/package names already installed by the user
 *   seen?: string[],        // repos already recommended on an earlier day
 *   max?: number,           // default 60
 *   perCategory?: number,   // default 2
 * }} [options]
 * @returns {{picked: object[], stats: {total:number, droppedInvalid:number,
 *   droppedInstalled:number, droppedSeen:number, droppedDuplicate:number,
 *   picked:number}}}
 */
export function selectCandidates(entries, options) {
  const list = Array.isArray(entries) ? entries : [];
  const opts = options && typeof options === 'object' ? options : {};

  const max = positiveInt(opts.max, DEFAULT_MAX);
  const perCategory = positiveInt(opts.perCategory, DEFAULT_PER_CATEGORY);
  const installed = toLookup(opts.installed);
  const seen = toLookup(opts.seen);

  const stats = {
    total: list.length,
    droppedInvalid: 0,
    droppedInstalled: 0,
    droppedSeen: 0,
    droppedDuplicate: 0,
    picked: 0,
  };

  const survivors = [];
  const survivorRepos = new Set();

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      stats.droppedInvalid += 1;
      continue;
    }

    // 1. Invalid — repo, name and url must all be non-empty after trimming.
    const repo = normalise(entry.repo);
    const name = normalise(entry.name);
    const url = normalise(entry.url);
    if (repo === '' || name === '' || url === '') {
      stats.droppedInvalid += 1;
      continue;
    }

    // 2. Already installed — by entry name or the last repo path segment.
    if (installed.size > 0) {
      const lastSegment = repo.split('/').pop();
      if (installed.has(name) || installed.has(lastSegment)) {
        stats.droppedInstalled += 1;
        continue;
      }
    }

    // 3. Already seen — normalised repo.
    if (seen.size > 0 && seen.has(repo)) {
      stats.droppedSeen += 1;
      continue;
    }

    // 4. Duplicate repo — keep the first occurrence among the survivors.
    if (survivorRepos.has(repo)) {
      stats.droppedDuplicate += 1;
      continue;
    }
    survivorRepos.add(repo);
    survivors.push(entry);
  }

  // 5. Category balance — round-robin, categories ordered by first appearance.
  /** @type {Map<string, object[]>} */
  const byCategory = new Map();
  for (const entry of survivors) {
    const category = entry.category === undefined || entry.category === null ? '' : String(entry.category);
    let bucket = byCategory.get(category);
    if (!bucket) {
      bucket = [];
      byCategory.set(category, bucket);
    }
    bucket.push(entry);
  }

  const buckets = [...byCategory.values()];
  const picked = [];
  for (let round = 0; round < perCategory && picked.length < max; round += 1) {
    for (const bucket of buckets) {
      if (picked.length >= max) break;
      if (round < bucket.length) picked.push(bucket[round]);
    }
  }

  stats.picked = picked.length;
  return { picked, stats };
}
