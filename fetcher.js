/**
 * Fetches live prices from Kalshi and/or Polymarket via pmxt.
 * Returns a normalized market snapshot for the arbitrage engine.
 */

import pmxt from 'pmxtjs';
import { config } from './config.js';

let kalshiClient = null;
let polyClient   = null;

export function initClients() {
  kalshiClient = new pmxt.Kalshi({
    apiKey:     config.kalshi.apiKey,
    privateKey: config.kalshi.privateKey,
  });

  if (config.polymarket.privateKey) {
    polyClient = new pmxt.Polymarket({
      privateKey:    config.polymarket.privateKey,
      funderAddress: config.polymarket.proxyAddress,
    });
    console.log('[fetcher] Initialized Kalshi + Polymarket clients');
  } else {
    console.log('[fetcher] Initialized Kalshi-only (no Polymarket key)');
  }

  return { kalshiClient, polyClient };
}

/**
 * Fetch live prices for a single configured market.
 * Returns null if either platform can't be reached.
 */
export async function fetchMarketPrices(market) {
  const result = {
    label: market.label,
    kalshiYes: null,
    kalshiNo:  null,
    polyYes:   null,
    polyNo:    null,
    daysToExpiry: market.daysToExpiry ?? estimateDaysToExpiry(market.kalshiSlug),
    volume: null,
  };

  // ── Kalshi ────────────────────────────────────────────────────────────────
  try {
    const markets = await kalshiClient.fetchMarkets({ slug: market.kalshiSlug, limit: 1 });
    if (markets.length) {
      const m   = markets[0];
      const yes = m.outcomes.find(o => o.label === 'Yes');
      const no  = m.outcomes.find(o => o.label === 'No');
      result.kalshiYes = yes?.price ?? null;
      result.kalshiNo  = no?.price  ?? null;

      // Use close date if available
      if (m.closeDate) {
        result.daysToExpiry = Math.max(1, Math.ceil(
          (new Date(m.closeDate) - Date.now()) / (1000 * 60 * 60 * 24)
        ));
      }
    }
  } catch (e) {
    console.warn(`[fetcher] Kalshi fetch failed for ${market.label}: ${e.message}`);
  }

  // ── Polymarket ────────────────────────────────────────────────────────────
  if (polyClient && market.polySlug) {
    try {
      const markets = await polyClient.fetchMarkets({ slug: market.polySlug, limit: 1 });
      if (markets.length) {
        const m   = markets[0];
        const yes = m.outcomes.find(o => o.label === 'Yes');
        const no  = m.outcomes.find(o => o.label === 'No');
        result.polyYes = yes?.price ?? null;
        result.polyNo  = no?.price  ?? null;
        result.volume  = m.volume ?? null;
      }
    } catch (e) {
      console.warn(`[fetcher] Polymarket fetch failed for ${market.label}: ${e.message}`);
    }
  }

  return result;
}

/** Fallback: guess expiry from common Kalshi slug patterns */
function estimateDaysToExpiry(slug) {
  const m = slug.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/i);
  if (!m) return 60;
  const months = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
  const year   = 2000 + parseInt(m[1]);
  const month  = months[m[2].toUpperCase()];
  const target = new Date(year, month - 1, 28);
  return Math.max(1, Math.ceil((target - Date.now()) / (1000 * 60 * 60 * 24)));
}
