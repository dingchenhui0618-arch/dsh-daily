import test from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';

import { parseCsv, parseCorpus, loadCorpus, searchCorpus } from '../src/corpus.js';

const HEADER = '"category","name","repo","url","desc"';

/** Build a small document with the canonical header. */
function doc(...rows) {
  return [HEADER, ...rows].join('\r\n') + '\r\n';
}

const SAMPLE_ROWS = [
  '"A","dsh-alpha","owner/dsh-alpha","https://github.com/owner/dsh-alpha","Memory palace for long sessions"',
  '"B","dsh-beta","other/dsh-beta","https://github.com/other/dsh-beta","Themes and appearance tweaks"',
  '"A","dsh-gamma","owner/dsh-gamma","https://github.com/owner/dsh-gamma","Billing reports and quotas"',
];

const SAMPLE_ENTRIES = parseCorpus(doc(...SAMPLE_ROWS));

test('parseCsv handles a quoted comma and "" escapes', () => {
  assert.deepEqual(parseCsv('"a,b","c""d"'), [['a,b', 'c"d']]);

  const entries = parseCorpus(
    doc('"Tools","dsh-a","owner/dsh-a","https://github.com/owner/dsh-a","A tool, with commas, and a ""quoted"" word."'),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].desc, 'A tool, with commas, and a "quoted" word.');
  assert.equal(entries[0].url, 'https://github.com/owner/dsh-a');
});

test('parseCsv keeps newlines inside quoted fields', () => {
  const rows = parseCsv('"a","line1\nline2"\n"b","x"\n');
  assert.deepEqual(rows, [
    ['a', 'line1\nline2'],
    ['b', 'x'],
  ]);

  // A CRLF inside quotes is field content, not a record terminator.
  assert.deepEqual(parseCsv('"a","x\r\ny"\r\n'), [['a', 'x\r\ny']]);

  const entries = parseCorpus(doc('"A","dsh-multi","owner/dsh-multi","https://github.com/owner/dsh-multi","first\nsecond"'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].desc, 'first\nsecond');
});

test('parseCsv treats CRLF and LF identically and drops blank trailing lines', () => {
  const crlf = parseCsv('"a","b"\r\n"c","d"\r\n');
  const lf = parseCsv('"a","b"\n"c","d"\n');
  assert.deepEqual(crlf, lf);
  assert.deepEqual(crlf, [
    ['a', 'b'],
    ['c', 'd'],
  ]);

  assert.deepEqual(parseCsv('"a","b"\n\n\n'), [['a', 'b']]);
  assert.deepEqual(parseCsv('"a","b"'), [['a', 'b']]);
  assert.deepEqual(parseCsv(''), []);
});

test('parseCorpus strips a leading BOM', () => {
  const entries = parseCorpus('\uFEFF' + doc(...SAMPLE_ROWS));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].category, 'A');
  assert.ok(!entries[0].category.includes('\uFEFF'));
  assert.ok(!JSON.stringify(entries).includes('\uFEFF'));
});

test('parseCorpus resolves columns by header name, not position', () => {
  const reordered = [
    '"desc","url","repo","name","category"',
    '"Reordered description","https://github.com/owner/dsh-x","owner/dsh-x","dsh-x","Zeta"',
  ].join('\r\n');
  const [entry] = parseCorpus(reordered);
  assert.deepEqual(entry, {
    category: 'Zeta',
    name: 'dsh-x',
    repo: 'owner/dsh-x',
    url: 'https://github.com/owner/dsh-x',
    desc: 'Reordered description',
  });

  // Unknown columns interleaved, and header casing/whitespace differences.
  const noisy = ['"note", "CATEGORY", "repo", " DESC ", "name", "url"', '"x","Alpha","owner/dsh-y","hello","dsh-y","u"'].join('\n');
  const [noisyEntry] = parseCorpus(noisy);
  assert.equal(noisyEntry.category, 'Alpha');
  assert.equal(noisyEntry.name, 'dsh-y');
  assert.equal(noisyEntry.repo, 'owner/dsh-y');
  assert.equal(noisyEntry.url, 'u');
  assert.equal(noisyEntry.desc, 'hello');

  // Positional parsing of the reordered document would have produced garbage.
  const rows = parseCsv(reordered);
  assert.notEqual(rows[1][0], 'Zeta');
});

test('parseCorpus yields empty strings for a missing column', () => {
  const [entry] = parseCorpus('"category","name","repo"\n"A","dsh-z","owner/dsh-z"\n');
  assert.deepEqual(entry, { category: 'A', name: 'dsh-z', repo: 'owner/dsh-z', url: '', desc: '' });

  // A short row leaves later columns missing too.
  const [short] = parseCorpus('"category","name","repo","url","desc"\n"A","dsh-s"\n');
  assert.equal(short.name, 'dsh-s');
  assert.equal(short.repo, '');
  assert.equal(short.url, '');
  assert.equal(short.desc, '');

  assert.deepEqual(parseCorpus(''), []);
});

test('loadCorpus returns [] for a missing or unreadable file without throwing', () => {
  assert.deepEqual(loadCorpus('D:/definitely/not/a/real/plugins.csv'), []);
  assert.deepEqual(loadCorpus('./no-such-directory/plugins.csv'), []);
  assert.deepEqual(loadCorpus(undefined), []);
  assert.deepEqual(loadCorpus(null), []);

  // A directory is readable only as a listing, so reading it as text must fail soft.
  const directory = fileURLToPath(new URL('.', import.meta.url));
  assert.deepEqual(loadCorpus(directory), []);
});

test('searchCorpus matches ANY term case-insensitively across name, desc and repo', () => {
  assert.deepEqual(
    searchCorpus(SAMPLE_ENTRIES, { terms: ['MEMORY'] }).map((e) => e.name),
    ['dsh-alpha'],
  );
  // repo is searched too, not just name/desc.
  assert.deepEqual(
    searchCorpus(SAMPLE_ENTRIES, { terms: ['OTHER/'] }).map((e) => e.name),
    ['dsh-beta'],
  );
  // ANY term, not every term.
  assert.deepEqual(
    searchCorpus(SAMPLE_ENTRIES, { terms: ['memory', 'BILLING'] }).map((e) => e.name),
    ['dsh-alpha', 'dsh-gamma'],
  );
  assert.deepEqual(
    searchCorpus(SAMPLE_ENTRIES, { terms: ['DSH-BETA'] }).map((e) => e.name),
    ['dsh-beta'],
  );
  assert.deepEqual(searchCorpus(SAMPLE_ENTRIES, { terms: ['nothing-matches-this'] }), []);
  assert.deepEqual(searchCorpus(SAMPLE_ENTRIES, { terms: [] }).length, 3);
  assert.deepEqual(searchCorpus(SAMPLE_ENTRIES, {}).length, 3);
});

test('searchCorpus filters categories exactly and case-sensitively', () => {
  assert.deepEqual(
    searchCorpus(SAMPLE_ENTRIES, { categories: ['A'] }).map((e) => e.name),
    ['dsh-alpha', 'dsh-gamma'],
  );
  assert.deepEqual(searchCorpus(SAMPLE_ENTRIES, { categories: ['a'] }), []);
  assert.deepEqual(searchCorpus(SAMPLE_ENTRIES, { categories: ['Alpha'] }), []);
  assert.deepEqual(
    searchCorpus(SAMPLE_ENTRIES, { categories: ['A', 'B'] }).map((e) => e.name),
    ['dsh-alpha', 'dsh-beta', 'dsh-gamma'],
  );
  // Category and term filters compose as AND.
  assert.deepEqual(
    searchCorpus(SAMPLE_ENTRIES, { categories: ['A'], terms: ['billing'] }).map((e) => e.name),
    ['dsh-gamma'],
  );
});

test('searchCorpus honours limit and never mutates the input array', () => {
  const input = SAMPLE_ENTRIES.slice();
  const snapshot = structuredClone(input);

  const limited = searchCorpus(input, { limit: 2 });
  assert.equal(limited.length, 2);
  assert.notEqual(limited, input, 'must return a NEW array');
  assert.deepEqual(limited.map((e) => e.name), ['dsh-alpha', 'dsh-beta']);

  assert.equal(searchCorpus(input, { limit: 1, terms: ['dsh-'] }).length, 1);
  assert.equal(searchCorpus(input, { limit: 99 }).length, 3);
  // A non-positive or non-integer limit is not a limit.
  assert.equal(searchCorpus(input, { limit: 0 }).length, 3);
  assert.equal(searchCorpus(input, { limit: -3 }).length, 3);
  assert.equal(searchCorpus(input, { limit: 2.5 }).length, 3);

  assert.deepEqual(input, snapshot, 'input array and its entries must be untouched');
});
