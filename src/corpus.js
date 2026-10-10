/**
 * Corpus parsing and search for the dsh-daily plugin survey CSV.
 *
 * The corpus document (`plugins.csv`) is RFC4180-style CSV, UTF-8 with a BOM,
 * one quoted field per column, header `"category","name","repo","url","desc"`.
 * Nothing here touches the network, and `loadCorpus` never throws.
 */
import { readFileSync } from 'node:fs';

const BOM = '\uFEFF';
const CORPUS_COLUMNS = ['category', 'name', 'repo', 'url', 'desc'];

/** Strip a single leading BOM, if present. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse RFC4180-style CSV text into rows of raw string cells. Handles quoted
 * fields, "" escapes, CRLF and LF line endings, and newlines inside quotes.
 * Blank trailing lines produce no row.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  if (typeof text !== 'string' || text.length === 0) return rows;

  const source = stripBom(text);
  const length = source.length;

  let row = [];
  let field = '';
  let inQuotes = false;
  // A record only materialises once it has consumed at least one character
  // other than a bare line terminator; that is what makes blank lines vanish.
  let recordHasChars = false;
  let index = 0;

  const endRecord = () => {
    if (!recordHasChars) return;
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    recordHasChars = false;
  };

  while (index < length) {
    const char = source[index];

    if (inQuotes) {
      recordHasChars = true;
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      recordHasChars = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      recordHasChars = true;
      index += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1;
      endRecord();
      continue;
    }

    field += char;
    recordHasChars = true;
    index += 1;
  }

  // A record still open at EOF counts only if it saw real characters, so a file
  // ending in a newline does not grow a phantom trailing row.
  if (recordHasChars) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Coerce a raw cell to a string, treating absent cells as ''. */
function cellAt(row, columnIndex) {
  if (columnIndex < 0 || columnIndex >= row.length) return '';
  const value = row[columnIndex];
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Map a plugins.csv document to entries, resolving columns BY HEADER NAME
 * (never by position). Strip a leading BOM. Skip rows that are entirely empty.
 * Coerce every field to a string; a missing column yields ''.
 *
 * @param {string} text
 * @returns {{category:string,name:string,repo:string,url:string,desc:string}[]}
 */
export function parseCorpus(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  const header = rows[0].map((cell) => stripBom(String(cell)).trim().toLowerCase());
  /** @type {Record<string, number>} */
  const positions = {};
  for (const column of CORPUS_COLUMNS) positions[column] = header.indexOf(column);

  const entries = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    // Guard for documents that reach here as hand-built rows of empty cells.
    if (row.every((cell) => cell === undefined || cell === null || String(cell).trim() === '')) continue;
    entries.push({
      category: cellAt(row, positions.category),
      name: cellAt(row, positions.name),
      repo: cellAt(row, positions.repo),
      url: cellAt(row, positions.url),
      desc: cellAt(row, positions.desc),
    });
  }
  return entries;
}

/**
 * Read a corpus file from disk. A missing or unreadable file returns [] and
 * MUST NOT throw. Strips the BOM.
 *
 * @param {string} path
 * @returns {{category:string,name:string,repo:string,url:string,desc:string}[]}
 */
export function loadCorpus(path) {
  try {
    const text = readFileSync(path, 'utf8');
    if (typeof text !== 'string') return [];
    return parseCorpus(text);
  } catch {
    return [];
  }
}

/**
 * Case-insensitive search.
 * query.terms: when non-empty, an entry matches if ANY term is a substring of
 *   name, desc or repo (case-insensitive). Empty/undefined terms = no term filter.
 * query.categories: when non-empty, keep only entries whose category is an exact
 *   (case-sensitive) member. Empty/undefined = no category filter.
 * query.limit: when a positive integer, truncate the result to that many entries.
 * Always returns a NEW array; never mutates the input.
 *
 * @param {object[]} entries
 * @param {{terms?:string[],categories?:string[],limit?:number}} [query]
 * @returns {object[]}
 */
export function searchCorpus(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const q = query && typeof query === 'object' ? query : {};

  const terms = Array.isArray(q.terms)
    ? q.terms
        .filter((term) => term !== undefined && term !== null)
        .map((term) => String(term).toLowerCase())
        .filter((term) => term.length > 0)
    : [];

  const categories = Array.isArray(q.categories)
    ? new Set(q.categories.filter((c) => c !== undefined && c !== null).map((c) => String(c)))
    : null;

  const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : null;

  const matches = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;

    if (categories && categories.size > 0 && !categories.has(String(entry.category))) continue;

    if (terms.length > 0) {
      const haystack = `${entry.name ?? ''}\n${entry.desc ?? ''}\n${entry.repo ?? ''}`.toLowerCase();
      if (!terms.some((term) => haystack.includes(term))) continue;
    }

    matches.push(entry);
    if (limit !== null && matches.length >= limit) break;
  }

  return matches;
}
