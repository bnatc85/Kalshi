/**
 * Market discovery — finds potential Kalshi/Polymarket pairs automatically.
 * Fetches active markets from both platforms, does keyword matching,
 * and stores candidates for human approval via the dashboard.
 */

import fs from 'fs';
import { getKalshiClient, initClients } from './fetcher.js';
import { config } from './config.js';

const CANDIDATES_FILE = './candidates.json';

// Load saved candidates
export function loadCandidates() {
  try {
    return JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// Save candidates
function saveCandidates(candidates) {
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(candidates, null, 2));
}

/**
 * Normalize text for matching: lowercase, remove punctuation, collapse spaces.
 */
function normalize(text) {
  return text.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract meaningful keywords from a market title.
 */
function extractKeywords(text) {
  const stop = new Set([
    'will', 'the', 'be', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for',
    'by', 'is', 'it', 'or', 'and', 'this', 'that', 'from', 'with', 'as',
    'are', 'was', 'were', 'has', 'have', 'had', 'do', 'does', 'did',
    'not', 'no', 'yes', 'if', 'than', 'then', 'its', 'there', 'their',
    'before', 'after', 'between', 'during', 'above', 'below', 'more',
    'most', 'any', 'each', 'which', 'what', 'when', 'where', 'how',
    'next', 'new', 'end', 'about',
  ]);
  return normalize(text)
    .split(' ')
    .filter(w => w.length > 1 && !stop.has(w));
}

/**
 * "Specific" keywords — longer words, proper nouns, numbers.
 * Generic words like "rate", "price", "change" get filtered out.
 */
const GENERIC_WORDS = new Set([
  'rate', 'rates', 'price', 'change', 'market', 'markets',
  'prime', 'minister', 'president', 'leader', 'election',
  'increase', 'decrease', 'cut', 'raise', 'meeting',
  'interest', 'federal', 'reserve', 'bps', 'basis', 'points',
  'supreme', 'government', 'party', 'vote', 'win',
]);

function isSpecific(word) {
  if (word.length < 3) return false;
  if (GENERIC_WORDS.has(word)) return false;
  return true;
}

/**
 * Score how well two sets of keywords match.
 * Requires specific keywords (names, countries, dates) to overlap,
 * not just generic terms like "prime minister".
 */
function matchScore(kw1, kw2) {
  const set1 = new Set(kw1);
  const set2 = new Set(kw2);
  let overlap = 0;
  let specificOverlap = 0;
  for (const w of set1) {
    if (set2.has(w)) {
      overlap++;
      if (isSpecific(w)) specificOverlap++;
    }
  }
  // Must have at least 1 specific keyword in common
  // (e.g. a country name, person name, or date)
  if (specificOverlap === 0) return 0;
  if (overlap < 2) return 0;

  const union = new Set([...set1, ...set2]).size;
  return (overlap / union) * (1 + specificOverlap * 0.4);
}

/**
 * Fetch active Kalshi markets (events with open markets).
 */
async function fetchKalshiMarkets() {
  const client = getKalshiClient();
  const markets = [];

  // Fetch in batches
  let cursor = null;
  for (let i = 0; i < 5; i++) {  // max 5 pages
    const params = { limit: 100, status: 'open' };
    if (cursor) params.cursor = cursor;
    const batch = await client.fetchMarkets(params);
    if (!batch.length) break;
    markets.push(...batch);
    // pmxt may not return a cursor; stop if we got fewer than limit
    if (batch.length < 100) break;
    await new Promise(r => setTimeout(r, 1500));
  }

  return markets;
}

/**
 * Fetch active Polymarket markets.
 */
async function fetchPolymarkets() {
  const markets = [];
  // Fetch multiple pages
  for (let offset = 0; offset < 500; offset += 100) {
    const url = `https://gamma-api.polymarket.com/markets?limit=100&offset=${offset}&active=true&closed=false`;
    const resp = await fetch(url);
    if (!resp.ok) break;
    const data = await resp.json();
    if (!data.length) break;
    markets.push(...data);
    await new Promise(r => setTimeout(r, 500));
  }
  return markets;
}

/**
 * Guess compareMode by checking if titles are aligned or inverted.
 * Returns 'direct' or 'kalshi-no-vs-poly-yes'.
 */
function guessCompareMode(kalshiTitle, polyTitle) {
  const kNorm = normalize(kalshiTitle);
  const pNorm = normalize(polyTitle);

  // If Kalshi has negation words that Poly doesn't, likely inverted
  const negations = ['no ', 'not ', 'won t ', 'wont ', 'no change', 'no acquisition'];
  const kHasNeg = negations.some(n => kNorm.includes(n));
  const pHasNeg = negations.some(n => pNorm.includes(n));

  if (kHasNeg !== pHasNeg) return 'kalshi-no-vs-poly-yes';
  return 'direct';
}

/**
 * Run discovery: fetch both platforms, find matches, save candidates.
 */
export async function runDiscovery() {
  console.log('[discovery] Fetching Kalshi markets...');
  const kalshiMarkets = await fetchKalshiMarkets();
  console.log(`[discovery] Got ${kalshiMarkets.length} Kalshi markets`);

  console.log('[discovery] Fetching Polymarket markets...');
  const polyMarkets = await fetchPolymarkets();
  console.log(`[discovery] Got ${polyMarkets.length} Polymarket markets`);

  // Already-configured tickers
  const existingTickers = new Set(config.markets.map(m => m.kalshiTicker));
  const existingCandidates = loadCandidates();
  const dismissedIds = new Set(existingCandidates.filter(c => c.status === 'dismissed').map(c => c.id));

  // Extract keywords for all poly markets
  const polyWithKw = polyMarkets.map(p => ({
    slug: p.slug,
    question: p.question,
    keywords: extractKeywords(p.question || ''),
    prices: JSON.parse(p.outcomePrices || '[]'),
  }));

  const candidates = [];

  for (const km of kalshiMarkets) {
    const ticker = km.marketId || km.ticker;
    if (!ticker || existingTickers.has(ticker)) continue;

    const kalshiTitle = km.title || km.question || ticker;
    const kKeywords = extractKeywords(kalshiTitle);
    if (kKeywords.length < 2) continue;

    // Find best Polymarket match
    let bestMatch = null;
    let bestScore = 0;

    for (const pm of polyWithKw) {
      if (!pm.keywords.length) continue;
      const score = matchScore(kKeywords, pm.keywords);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = pm;
      }
    }

    // Threshold: need good match with specific keyword overlap
    if (bestScore < 0.4 || !bestMatch) continue;

    const id = `${ticker}::${bestMatch.slug}`;
    if (dismissedIds.has(id)) continue;

    const compareMode = guessCompareMode(kalshiTitle, bestMatch.question);

    candidates.push({
      id,
      kalshiTicker: ticker,
      kalshiTitle,
      polySlug: bestMatch.slug,
      polyQuestion: bestMatch.question,
      compareMode,
      matchScore: Math.round(bestScore * 100) / 100,
      kalshiPrice: km.yes?.price ?? km.outcomes?.[0]?.price ?? null,
      polyPrice: parseFloat(bestMatch.prices[0]) || null,
      discoveredAt: new Date().toISOString(),
      status: 'pending',  // pending | approved | dismissed
    });
  }

  // Sort by match score descending
  candidates.sort((a, b) => b.matchScore - a.matchScore);

  // Merge with existing candidates (keep approved/dismissed status)
  const existingMap = new Map(existingCandidates.map(c => [c.id, c]));
  const merged = [];

  for (const c of candidates) {
    const existing = existingMap.get(c.id);
    if (existing) {
      // Keep status, update prices
      merged.push({ ...c, status: existing.status });
    } else {
      merged.push(c);
    }
  }

  // Also keep dismissed ones so they stay dismissed
  for (const ec of existingCandidates) {
    if (ec.status === 'dismissed' && !merged.find(m => m.id === ec.id)) {
      merged.push(ec);
    }
  }

  saveCandidates(merged);
  const pending = merged.filter(c => c.status === 'pending');
  console.log(`[discovery] Found ${pending.length} new candidates (${merged.length} total)`);

  return { total: merged.length, pending: pending.length, candidates: merged };
}

/**
 * Approve a candidate — adds it to config.markets at runtime.
 */
export function approveCandidate(id) {
  const candidates = loadCandidates();
  const c = candidates.find(x => x.id === id);
  if (!c) return { error: 'Candidate not found' };

  c.status = 'approved';
  saveCandidates(candidates);

  // Add to runtime config
  const label = c.kalshiTitle.length > 40
    ? c.kalshiTitle.substring(0, 37) + '...'
    : c.kalshiTitle;

  const newMarket = {
    label,
    kalshiTicker: c.kalshiTicker,
    polySlug: c.polySlug,
    compareMode: c.compareMode,
  };

  // Don't add duplicate
  if (!config.markets.find(m => m.kalshiTicker === c.kalshiTicker)) {
    config.markets.push(newMarket);
  }

  return { success: true, market: newMarket };
}

/**
 * Dismiss a candidate — won't show up again.
 */
export function dismissCandidate(id) {
  const candidates = loadCandidates();
  const c = candidates.find(x => x.id === id);
  if (!c) return { error: 'Candidate not found' };

  c.status = 'dismissed';
  saveCandidates(candidates);
  return { success: true };
}
