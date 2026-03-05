/**
 * Auto-discovery: Finds matching markets across Kalshi and Polymarket.
 * Matches by event-level similarity, then checks specific outcome divergences.
 *
 * Run: npm run discover
 */

import pmxt from 'pmxtjs';
import { validateConfig, config } from './config.js';

validateConfig();

const kalshi = new pmxt.Kalshi({
  apiKey: config.kalshi.apiKey,
  privateKey: config.kalshi.privateKey,
});

console.log('\n=== Signal BonBon Market Discovery ===\n');

// ── Fetch markets ──────────────────────────────────────────────────────────

console.log('[1/3] Fetching markets...');
const kalshiMarkets = await kalshi.fetchMarkets({ limit: 500 });
console.log(`  Kalshi: ${kalshiMarkets.length}`);

const polyMarkets = [];
for (let offset = 0; offset < 500; offset += 100) {
  try {
    const url = `https://gamma-api.polymarket.com/markets?closed=false&limit=100&offset=${offset}&order=volume24hr&ascending=false`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.length === 0) break;
    polyMarkets.push(...data);
  } catch (e) { break; }
}
console.log(`  Polymarket: ${polyMarkets.length}`);

// ── Normalize and match ────────────────────────────────────────────────────

console.log('[2/3] Matching...');

// Extract the core subject from a title
// "Will the Fed decrease interest rates by 25 bps after the March 2026 meeting?"
//  => "fed decrease interest rates 25 bps march 2026"
// "Who will be the next Supreme Leader of Iran?"
//  => "next supreme leader iran"
function normalize(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[?!.,'"()]/g, '')
    .replace(/\b(will|the|be|a|an|of|in|by|to|for|on|at|or|and|is|are|was|has|have|this|that|their|its|from|with|who|what|when|where|how|does|do|did|may|can|could|would|should|than|more|most|very|just|also|only|even|still|already|yet|here|there|some|any|each|every|other|after|before|between|through|during|about|above|below|over|under|into|out|which|then)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Get significant bigrams (consecutive word pairs) for better matching
function bigrams(text) {
  const words = text.split(' ').filter(w => w.length > 2);
  const result = [];
  for (let i = 0; i < words.length - 1; i++) {
    result.push(words[i] + ' ' + words[i + 1]);
  }
  return result;
}

// Score match between two titles using word overlap + bigram overlap
function similarity(t1, t2) {
  const n1 = normalize(t1);
  const n2 = normalize(t2);

  const w1 = new Set(n1.split(' ').filter(w => w.length > 2));
  const w2 = new Set(n2.split(' ').filter(w => w.length > 2));

  // Word Jaccard
  let overlap = 0;
  for (const w of w1) { if (w2.has(w)) overlap++; }
  const union = new Set([...w1, ...w2]).size;
  if (union === 0) return 0;
  const wordJaccard = overlap / union;

  // Bigram overlap (much stricter)
  const b1 = new Set(bigrams(n1));
  const b2 = new Set(bigrams(n2));
  let bOverlap = 0;
  for (const b of b1) { if (b2.has(b)) bOverlap++; }
  const bUnion = new Set([...b1, ...b2]).size;
  const bigramJaccard = bUnion > 0 ? bOverlap / bUnion : 0;

  // Require BOTH word and bigram overlap for a match
  // This prevents "next PM of UK" matching "next PM of Hungary"
  return (wordJaccard * 0.4) + (bigramJaccard * 0.6);
}

function polyPrices(m) {
  try {
    const prices = JSON.parse(m.outcomePrices || '[]');
    return { yes: parseFloat(prices[0]), no: parseFloat(prices[1]) };
  } catch { return null; }
}

// Find matching pairs
const pairs = [];
const seen = new Set();

for (const km of kalshiMarkets) {
  const kTitle = km.title || '';
  const kYes = km.yes?.price ?? km.outcomes?.[0]?.price ?? null;
  if (kYes === null) continue;

  for (const pm of polyMarkets) {
    const pTitle = pm.question || '';
    const pp = polyPrices(pm);
    if (!pp || pp.yes === null) continue;

    const score = similarity(kTitle, pTitle);
    if (score < 0.25) continue;

    const key = km.marketId + '|' + pm.id;
    if (seen.has(key)) continue;
    seen.add(key);

    // Direct comparison
    const div = Math.abs(pp.yes - kYes);
    const divBps = div * 10000;
    if (divBps < 200) continue;

    pairs.push({
      kalshiId: km.marketId,
      kalshiTitle: kTitle,
      kalshiYes: kYes,
      kalshiVol: km.volume24h || 0,
      polySlug: pm.slug,
      polyTitle: pTitle,
      polyYes: pp.yes,
      polyVol: parseFloat(pm.volume24hr || 0),
      score,
      divBps,
      direction: pp.yes > kYes ? 'BUY YES (K cheap)' : 'BUY NO (K expensive)',
    });
  }
}

// Sort by score then divergence
pairs.sort((a, b) => {
  if (Math.abs(a.score - b.score) > 0.1) return b.score - a.score;
  return b.divBps - a.divBps;
});

// Deduplicate: best per unique Kalshi event + Poly event combo
const best = [];
const seenCombos = new Set();
for (const p of pairs) {
  // Strip last suffix to get event-level key
  const kEvent = p.kalshiId.replace(/-[A-Z0-9.]+$/, '');
  const pEvent = p.polySlug.replace(/-\d+$/, '');
  const combo = kEvent + '||' + pEvent;
  if (seenCombos.has(combo)) continue;
  seenCombos.add(combo);
  best.push(p);
}

// ── Display ────────────────────────────────────────────────────────────────

console.log(`[3/3] Found ${best.length} matched pairs\n`);

if (best.length === 0) {
  console.log('No matching markets with divergence found.\n');
} else {
  console.log('='.repeat(95));

  for (const p of best.slice(0, 30)) {
    const scorePct = (p.score * 100).toFixed(0);
    const volK = p.kalshiVol > 100 ? 'ok' : 'LOW';
    const volP = p.polyVol > 50000 ? 'ok' : 'LOW';

    console.log(`\n  K: ${p.kalshiTitle.substring(0, 80)}`);
    console.log(`     ${p.kalshiId}  YES=${(p.kalshiYes * 100).toFixed(1)}c  vol24h=${p.kalshiVol}`);
    console.log(`  P: ${p.polyTitle.substring(0, 80)}`);
    console.log(`     YES=${(p.polyYes * 100).toFixed(1)}c  vol24h=${Math.round(p.polyVol)}`);
    console.log(`  Match: ${scorePct}%  |  Div: ${p.divBps.toFixed(0)} bps  |  ${p.direction}  |  K:${volK} P:${volP}`);
    console.log(`  -> { kalshiTicker: '${p.kalshiId}', polySlug: '${p.polySlug}', compareMode: 'direct' }`);
  }

  console.log('\n' + '='.repeat(95));
  console.log('\nPrices are LAST-TRADED. Check dashboard for live order book depth.');
  console.log('Copy a config line into config.js to track a market.\n');
}

console.log('=== Done ===\n');
