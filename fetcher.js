/**
 * Fetches live prices from Kalshi (via pmxt) and Polymarket (public gamma API).
 * Includes order book depth for Kalshi markets.
 */

import pmxt from 'pmxtjs';
import { config } from './config.js';

let kalshiClient = null;

export function initClients() {
  kalshiClient = new pmxt.Kalshi({
    apiKey:     config.kalshi.apiKey,
    privateKey: config.kalshi.privateKey,
  });
  console.log('[fetcher] Initialized Kalshi client (Polymarket via public API)');
  return { kalshiClient };
}

export function getKalshiClient() {
  return kalshiClient;
}

/**
 * Fetch a Kalshi market by ticker, with fallback for multi-outcome markets.
 * pmxt's ticker param returns wrong results for multi-outcome candidate suffixes
 * (e.g., KXNEXTIRANLEADER-45JAN01-MKHA). In that case, use the event slug
 * (everything before the last hyphenated suffix) and filter results by marketId.
 */
export async function fetchKalshiMarket(ticker) {
  // Try direct ticker lookup first
  const direct = await kalshiClient.fetchMarkets({ ticker, limit: 1 });
  if (direct.length && direct[0].marketId === ticker) {
    return direct;
  }

  // Ticker returned wrong market or nothing — try slug-based lookup
  // Extract event slug: everything before the last dash-separated segment
  // e.g., KXNEXTIRANLEADER-45JAN01-MKHA → KXNEXTIRANLEADER-45JAN01
  const lastDash = ticker.lastIndexOf('-');
  if (lastDash > 0) {
    const eventSlug = ticker.substring(0, lastDash);
    try {
      const allOutcomes = await kalshiClient.fetchMarkets({ slug: eventSlug });
      const match = allOutcomes.filter(m => m.marketId === ticker);
      if (match.length) return match;
    } catch (e) {
      // slug lookup failed, fall through
    }
  }

  // Return whatever we got (may be empty or wrong, caller handles it)
  return direct;
}

/**
 * Fetch a Polymarket market by slug using the public gamma API.
 */
async function fetchPolymarketBySlug(slug) {
  const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.length) return null;
  const prices = JSON.parse(data[0].outcomePrices || '[]');
  return {
    yes: parseFloat(prices[0]) || null,
    no:  parseFloat(prices[1]) || null,
    question: data[0].question,
  };
}

/**
 * Fetch the Kalshi order book for a ticker.
 * Returns { bids, asks } for the YES side, plus computed NO-side equivalents.
 */
export async function fetchOrderBook(ticker) {
  const ob = { yesBids: [], yesAsks: [], noBids: [], noAsks: [], spread: null, fillable: null };

  try {
    // YES side
    const yesOb = await kalshiClient.fetchOrderBook(ticker);
    ob.yesBids = (yesOb.bids || []).map(l => ({ price: l.price, size: l.size }));
    ob.yesAsks = (yesOb.asks || []).map(l => ({ price: l.price, size: l.size }));
  } catch (e) {
    console.warn(`[fetcher] YES order book failed for ${ticker}: ${e.message}`);
  }

  try {
    // NO side
    const noOb = await kalshiClient.fetchOrderBook(ticker + '-NO');
    ob.noBids = (noOb.bids || []).map(l => ({ price: l.price, size: l.size }));
    ob.noAsks = (noOb.asks || []).map(l => ({ price: l.price, size: l.size }));
  } catch (e) {
    // NO order book not always available separately
  }

  // Compute spread and fillability
  const bestYesBid = ob.yesBids[0]?.price ?? null;
  const bestYesAsk = ob.yesAsks[0]?.price ?? null;
  const bestNoBid  = ob.noBids[0]?.price  ?? null;
  const bestNoAsk  = ob.noAsks[0]?.price  ?? null;

  ob.spread = {
    yesBid: bestYesBid,
    yesAsk: bestYesAsk,
    yesBidAskSpread: bestYesBid && bestYesAsk ? bestYesAsk - bestYesBid : null,
    noBid: bestNoBid,
    noAsk: bestNoAsk,
    noBidAskSpread: bestNoBid && bestNoAsk ? bestNoAsk - bestNoBid : null,
  };

  // Fillability: how many contracts can you buy/sell at best price
  // Buying NO with no NO asks = buying YES asks (Kalshi links them)
  const yesBuySize  = ob.yesAsks[0]?.size ?? 0;
  const yesSellSize = ob.yesBids[0]?.size ?? 0;
  const noBuySize   = ob.noAsks[0]?.size  ?? 0;
  const noSellSize  = ob.noBids[0]?.size  ?? 0;

  ob.fillable = {
    yesBuy:  yesBuySize  || noSellSize,
    yesSell: yesSellSize || noBuySize,
    noBuy:   noBuySize   || yesSellSize || yesBuySize,
    noSell:  noSellSize  || yesBuySize,
    yesBuyDepth:  ob.yesAsks.reduce((s, l) => s + l.size, 0) || ob.noBids.reduce((s, l) => s + l.size, 0),
    yesSellDepth: ob.yesBids.reduce((s, l) => s + l.size, 0) || ob.noAsks.reduce((s, l) => s + l.size, 0),
    noBuyDepth:   ob.noAsks.reduce((s, l) => s + l.size, 0) || ob.yesBids.reduce((s, l) => s + l.size, 0) || ob.yesAsks.reduce((s, l) => s + l.size, 0),
    noSellDepth:  ob.noBids.reduce((s, l) => s + l.size, 0) || ob.yesAsks.reduce((s, l) => s + l.size, 0),
  };

  return ob;
}

/**
 * Fetch live prices for a single configured market from both platforms.
 */
export async function fetchMarketPrices(market) {
  const result = {
    label: market.label,
    kalshiYes: null,
    kalshiNo:  null,
    polyYes:   null,
    polyNo:    null,
    kalshiPrice: null,
    polyPrice:   null,
    kalshiSide:  null,
    daysToExpiry: null,
    orderBook: null,
  };

  // Kalshi prices + order book in parallel
  try {
    const [markets, ob] = await Promise.all([
      fetchKalshiMarket(market.kalshiTicker),
      fetchOrderBook(market.kalshiTicker),
    ]);

    if (markets.length) {
      const m = markets[0];
      // Use order book for real tradeable prices instead of last-traded
      const obYesBestAsk = ob.spread.yesAsk;
      const obNoBestAsk  = ob.spread.noAsk;
      const obYesBestBid = ob.spread.yesBid;
      const obNoBestBid  = ob.spread.noBid;

      // Last-traded price (for reference)
      result.kalshiYesLast = m.yes?.price ?? m.outcomes?.[0]?.price ?? null;
      result.kalshiNoLast  = m.no?.price  ?? m.outcomes?.[1]?.price ?? null;

      // Tradeable prices: what you'd actually pay to BUY each side
      // On Kalshi, buying NO at Xc = buying YES at (100-X)c
      // So: NO effective ask = 1 - YES best bid (if YES bids exist)
      //     NO effective ask = NO direct ask (if NO asks exist)
      //     Fallback: 1 - YES ask (the implied complement price)
      result.kalshiYes = obYesBestAsk ?? result.kalshiYesLast;
      result.kalshiNo  = obNoBestAsk
        ?? (obYesBestBid != null ? 1 - obYesBestBid : null)
        ?? (obYesBestAsk != null ? 1 - obYesBestAsk : null)
        ?? (result.kalshiYesLast != null ? 1 - result.kalshiYesLast : null);

      // Bid prices (what you'd get if selling)
      result.kalshiYesBid = obYesBestBid
        ?? (obNoBestAsk != null ? 1 - obNoBestAsk : null);
      result.kalshiNoBid  = obNoBestBid
        ?? (obYesBestAsk != null ? 1 - obYesBestAsk : null);

      result.orderBook = ob;
    }
  } catch (e) {
    console.warn(`[fetcher] Kalshi fetch failed for ${market.label}: ${e.message}`);
  }

  // Expiry
  if (market.expiryDate) {
    result.daysToExpiry = Math.max(1, Math.ceil(
      (new Date(market.expiryDate) - Date.now()) / (1000 * 60 * 60 * 24)
    ));
  }

  // Polymarket
  if (market.polySlug) {
    try {
      const poly = await fetchPolymarketBySlug(market.polySlug);
      if (poly) {
        result.polyYes = poly.yes;
        result.polyNo  = poly.no;
      }
    } catch (e) {
      console.warn(`[fetcher] Polymarket fetch failed for ${market.label}: ${e.message}`);
    }
  }

  // Normalize prices based on compare mode (using tradeable ask prices)
  if (result.kalshiYes !== null && result.polyYes !== null) {
    switch (market.compareMode) {
      case 'direct':
        result.kalshiPrice = result.kalshiYes;
        result.polyPrice = result.polyYes;
        result.kalshiSide = 'yes';
        break;
      case 'kalshi-no-vs-poly-yes':
        result.kalshiPrice = result.kalshiNo;
        result.polyPrice = result.polyYes;
        result.kalshiSide = 'no';
        break;
      default:
        result.kalshiPrice = result.kalshiYes;
        result.polyPrice = result.polyYes;
        result.kalshiSide = 'yes';
    }
  }

  if (!result.daysToExpiry) {
    result.daysToExpiry = estimateDaysToExpiry(market.kalshiTicker);
  }

  return result;
}

function estimateDaysToExpiry(ticker) {
  const m = ticker.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/i);
  if (!m) return 60;
  const months = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
  const year   = 2000 + parseInt(m[1]);
  const month  = months[m[2].toUpperCase()];
  const target = new Date(year, month - 1, 28);
  return Math.max(1, Math.ceil((target - Date.now()) / (1000 * 60 * 60 * 24)));
}
