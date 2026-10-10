import test from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';

import { loadCorpus } from '../src/corpus.js';
import { selectCandidates } from '../src/select.js';

const REAL_CORPUS = 'D:\\Projects\\dsh-plugin-survey\\data\\plugins.csv';

/** Minimal well-formed entry. */
function mk(category, name, repo) {
  return { category, name, repo, url: `https://github.com/${repo}`, desc: `${name} description` };
}

const ZERO_STATS = {
  total: 0,
  droppedInvalid: 0,
  droppedInstalled: 0,
  droppedSeen: 0,
  droppedDuplicate: 0,
  picked: 0,
};

test('installed matches through both the entry name and the last repo segment', () => {
  const entries = [
    mk('A', 'my-tool', 'owner/pkg-name'), // name match only
    mk('A', 'SomeName', 'owner/installed-pkg'), // last repo segment match only
    mk('B', 'KeepMe', 'owner/keep-me'), // survives
  ];

  const { picked, stats } = selectCandidates(entries, { installed: ['  MY-TOOL  ', 'Installed-Pkg'] });

  assert.deepEqual(picked.map((e) => e.name), ['KeepMe']);
  assert.equal(stats.total, 3);
  assert.equal(stats.droppedInstalled, 2, 'normalisation is trim + lowercase on both sides');
  assert.equal(stats.droppedInvalid, 0);
  assert.equal(stats.picked, picked.length);
});

test('seen drops repos already recommended on an earlier day', () => {
  const entries = [mk('A', 'a', 'owner/a'), mk('A', 'b', 'owner/b'), mk('B', 'c', 'Owner/C')];

  const { picked, stats } = selectCandidates(entries, { seen: [' OWNER/A ', 'owner/c'] });

  assert.deepEqual(picked.map((e) => e.repo), ['owner/b']);
  assert.equal(stats.droppedSeen, 2);
  assert.equal(stats.droppedInstalled, 0);
});

test('duplicate repos collapse to the first occurrence and the rest are counted', () => {
  const first = mk('A', 'first', 'owner/dup');
  const later = mk('A', 'later', 'owner/dup');
  const laterCased = mk('A', 'later-cased', 'Owner/DUP');

  const { picked, stats } = selectCandidates([first, later, laterCased, mk('A', 'solo', 'owner/solo')], { perCategory: 5 });

  assert.equal(stats.droppedDuplicate, 2);
  assert.equal(picked.length, 2);
  assert.equal(picked[0], first, 'the identical first object is kept');
  assert.deepEqual(picked.map((e) => e.name), ['first', 'solo']);
});

test('perCategory caps every category and categories interleave round-robin', () => {
  const z1 = mk('Zeta', 'z1', 'owner/z1');
  const z2 = mk('Zeta', 'z2', 'owner/z2');
  const z3 = mk('Zeta', 'z3', 'owner/z3');
  const a1 = mk('Alpha', 'a1', 'owner/a1');
  const a2 = mk('Alpha', 'a2', 'owner/a2');
  const m1 = mk('Mid', 'm1', 'owner/m1');

  // 'Zeta' appears first, so it leads — the order is first-appearance, not alphabetical.
  const { picked } = selectCandidates([z1, z2, z3, a1, a2, m1], { perCategory: 2, max: 100 });

  assert.deepEqual(picked.map((e) => e.name), ['z1', 'a1', 'm1', 'z2', 'a2']);
  assert.ok(!picked.includes(z3), 'the third Zeta entry exceeds perCategory');

  const perCategoryCount = new Map();
  for (const entry of picked) perCategoryCount.set(entry.category, (perCategoryCount.get(entry.category) ?? 0) + 1);
  for (const [category, count] of perCategoryCount) assert.ok(count <= 2, `${category} contributed ${count}`);
  assert.equal(picked[0].category, 'Zeta', 'first-appearance order decides which category leads');
});

test('max truncates the round-robin shortlist', () => {
  const entries = [];
  for (const category of ['Zeta', 'Alpha', 'Mid']) {
    for (let i = 1; i <= 3; i += 1) entries.push(mk(category, `${category}-${i}`, `owner/${category}-${i}`));
  }

  const { picked, stats } = selectCandidates(entries, { max: 4, perCategory: 3 });

  assert.deepEqual(picked.map((e) => e.name), ['Zeta-1', 'Alpha-1', 'Mid-1', 'Zeta-2']);
  assert.equal(stats.picked, 4);
  assert.equal(stats.picked, picked.length);

  // max above the available supply simply yields everything allowed.
  const all = selectCandidates(entries, { max: 100, perCategory: 3 });
  assert.equal(all.picked.length, 9);
});

test('empty input and omitted options yield empty results with zeroed stats', () => {
  assert.deepEqual(selectCandidates([]), { picked: [], stats: { ...ZERO_STATS } });
  assert.deepEqual(selectCandidates([], undefined), { picked: [], stats: { ...ZERO_STATS } });
  assert.deepEqual(selectCandidates([], { installed: [], seen: [], max: 10, perCategory: 3 }), {
    picked: [],
    stats: { ...ZERO_STATS },
  });
  // Non-array input is tolerated rather than thrown on.
  assert.deepEqual(selectCandidates(undefined), { picked: [], stats: { ...ZERO_STATS } });

  // Nothing survives: still no throw, still an empty pick, drops still reported.
  const { picked, stats } = selectCandidates([
    { category: 'A', name: '', repo: 'owner/x', url: 'https://github.com/owner/x', desc: '' },
    { category: 'A', name: 'ok', repo: '   ', url: 'https://github.com/owner/y', desc: '' },
  ]);
  assert.deepEqual(picked, []);
  assert.equal(stats.total, 2);
  assert.equal(stats.droppedInvalid, 2);
  assert.equal(stats.picked, 0);
});

test('the input array and its entry objects are never mutated', () => {
  const entries = [
    mk('Zeta', 'z1', 'owner/z1'),
    mk('Zeta', 'z2', 'owner/dup'),
    mk('Alpha', 'a1', 'owner/dup'),
    { category: 'Alpha', name: '', repo: '', url: '', desc: '' },
  ];
  const snapshot = structuredClone(entries);

  selectCandidates(entries, {
    installed: ['z1'],
    seen: ['owner/z2'],
    max: 2,
    perCategory: 1,
  });

  assert.deepEqual(entries, snapshot);

  // Frozen input in strict mode would throw on any write attempt.
  const frozen = Object.freeze([
    Object.freeze(mk('Zeta', 'z1', 'owner/z1')),
    Object.freeze(mk('Alpha', 'a1', 'owner/a1')),
  ]);
  assert.doesNotThrow(() => selectCandidates(frozen, { max: 2, perCategory: 2 }));
});

test('selectCandidates on the real plugins.csv corpus', { skip: existsSync(REAL_CORPUS) ? false : `corpus not found at ${REAL_CORPUS}` }, () => {
  const entries = loadCorpus(REAL_CORPUS);
  assert.ok(entries.length > 3000, `expected >3000 entries, got ${entries.length}`);
  const emptyRepos = entries.filter((e) => !e.repo || e.repo.trim() === '');
  assert.equal(emptyRepos.length, 0, 'every corpus entry must carry a non-empty repo');

  // perCategory must be raised above the default 2: the corpus has only 23
  // categories, so 23 x 2 = 46 candidates exist for a max of 60.
  const { picked, stats } = selectCandidates(entries, { max: 60, perCategory: 60 });

  assert.equal(picked.length, 60);
  assert.equal(stats.picked, 60);
  assert.equal(stats.total, entries.length);
  assert.equal(stats.droppedInvalid, 0);
  assert.equal(stats.droppedInstalled, 0);
  assert.equal(stats.droppedSeen, 0);

  const known = new Set(entries);
  const repos = new Set();
  const perCategory = new Map();
  for (const entry of picked) {
    assert.ok(known.has(entry), 'picked entries must come from the corpus');
    assert.ok(!repos.has(entry.repo.trim().toLowerCase()), `duplicate picked repo ${entry.repo}`);
    repos.add(entry.repo.trim().toLowerCase());
    perCategory.set(entry.category, (perCategory.get(entry.category) ?? 0) + 1);
  }
  for (const [category, count] of perCategory) assert.ok(count <= 60, `${category} contributed ${count}`);

  // The default perCategory caps the shortlist below max on this corpus, by design.
  const withDefaults = selectCandidates(entries);
  assert.ok(withDefaults.picked.length > 0 && withDefaults.picked.length <= 60);
  assert.equal(withDefaults.stats.picked, withDefaults.picked.length);
});
