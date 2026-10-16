// End-to-end check of the popularity-driven shortlist against the LIVE market.
//
// Run by hand: `node scripts/verify-market.mjs`
//
// It uses the real global fetch, the real catalog document, the real parser, the
// real scoring and the real selection — everything except the host wiring, which
// the injected-double tests in test/host.test.mjs cover. It prints what the daily
// report would actually be offered, so "these numbers are real" can be checked
// rather than believed.
//
// The A/B at the bottom is the point of the whole feature: it runs the SAME
// candidate set through the selection twice, once with popularity scores and
// once without, and reports how much more installed the resulting shortlist is.
// The local corpus CSV is the right fixture for that comparison precisely because
// it is NOT ordered by downloads, unlike the live catalog (whose document order
// happens to be download-descending, which would make the two runs identical and
// prove nothing).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMarket, popularityScores, popularityLabel } from '../src/market.js';
import { selectCandidates } from '../src/select.js';
import { buildReportPrompt } from '../src/report.js';
import { loadCorpus } from '../src/corpus.js';

const cachePath = join(mkdtempSync(join(tmpdir(), 'dsh-daily-live-')), 'market-cache.json');
const started = Date.now();
const { entries, meta } = await loadMarket({ cachePath, fetchImpl: globalThis.fetch });

console.log('=== 市场数据 ===');
console.log('  status        ', meta.status);
console.log('  source        ', meta.source);
console.log('  sourceDate    ', meta.sourceDate, '(文档里最新一条 added)');
console.log('  entries       ', meta.total);
console.log('  withDownloads ', meta.withDownloads, '| withStars', meta.withStars);
console.log('  warning       ', JSON.stringify(meta.warning || ''));
console.log('  取回耗时      ', Date.now() - started, 'ms');

if (entries.length === 0) {
  console.error('\n取不到目录：后面的检查没有意义，先看 warning。');
  process.exit(1);
}

const scores = popularityScores(entries);

// How the weighting behaves on THIS document (download-descending upstream) …
const here = selectCandidates(entries, { scores, max: 60, perCategory: 4 });
const hereUnranked = selectCandidates(entries, { max: 60, perCategory: 4 });
console.log('\n=== 在市场目录上预筛 ===');
console.log('  stats', JSON.stringify(here.stats));
console.log('  与不排序的结果差异条目', here.picked.filter((e) => !hereUnranked.picked.includes(e)).length,
  '(目录本身已按下载量降序，所以这里应当接近 0)');
const missingPopularity = here.picked.filter((e) => typeof e.downloads !== 'number' && typeof e.stars !== 'number').length;
console.log('  候选里没有热门度数字的', missingPopularity, '/', here.picked.length);

// … and on the local corpus, which is not ordered by anything. This is the real
// A/B: the source of truth is the market index, joined by URL.
const corpusPath = process.argv[2] || join(process.env.USERPROFILE || '', '.dsh', 'daily', 'corpus.csv');
const corpus = loadCorpus(corpusPath);
if (corpus.length > 0) {
  const index = new Map(entries.map((e) => [e.url.toLowerCase().replace(/\/+$/, ''), e]));
  let joined = 0;
  for (const entry of corpus) {
    const hit = index.get(String(entry.url).toLowerCase().replace(/\/+$/, ''));
    if (hit === undefined) continue;
    joined += 1;
    entry.downloads = hit.downloads;
    entry.stars = hit.stars;
  }
  const corpusScores = popularityScores(corpus);
  const ranked = selectCandidates(corpus, { scores: corpusScores, max: 60, perCategory: 4 });
  const unranked = selectCandidates(corpus, { max: 60, perCategory: 4 });
  const sum = (list) => list.reduce((total, e) => total + (typeof e.downloads === 'number' ? e.downloads : 0), 0);
  const median = (list) => {
    const values = list.map((e) => (typeof e.downloads === 'number' ? e.downloads : 0)).sort((a, b) => a - b);
    return values.length === 0 ? 0 : values[Math.floor(values.length / 2)];
  };
  console.log('\n=== 在本地语料上 A/B（语料 ' + corpus.length + ' 条，其中 ' + joined + ' 条能join到市场数据）===');
  console.log('  排序后候选下载量合计  ', sum(ranked.picked).toLocaleString('en-US'), '中位数', median(ranked.picked).toLocaleString('en-US'));
  console.log('  不排序候选下载量合计  ', sum(unranked.picked).toLocaleString('en-US'), '中位数', median(unranked.picked).toLocaleString('en-US'));
  const ratio = sum(unranked.picked) === 0 ? 0 : sum(ranked.picked) / sum(unranked.picked);
  console.log('  倍数                  ', ratio.toFixed(2) + 'x');
  console.log('  被换掉/新进的条目     ', ranked.picked.filter((e) => !unranked.picked.includes(e)).length);
} else {
  console.log('\n(跳过语料 A/B：读不到 ' + corpusPath + ')');
}

console.log('\n=== 每个分类的头名（报告会优先看到这些）===');
const byCategory = new Map();
for (const entry of here.picked) {
  if (!byCategory.has(entry.category)) byCategory.set(entry.category, entry);
}
for (const [category, entry] of byCategory) {
  console.log('  ' + String(category).slice(0, 26).padEnd(28) + entry.repo.padEnd(50) + popularityLabel(entry));
}

console.log('\n=== 提示词里候选行长什么样（前 4 行）===');
const prompt = buildReportPrompt({
  date: '2026-10-15', brief: '(brief)', candidates: here.picked.slice(0, 4),
  maxImprovements: 10, maxIdeas: 3, pastIdeas: [],
  popularityOf: (e) => popularityLabel(e),
});
for (const line of prompt.split('\n')) {
  if (line.startsWith('- ') && line.indexOf('|') > 0) console.log('  ' + line.slice(0, 140));
}
console.log('\n  提示词字符数', prompt.length);
