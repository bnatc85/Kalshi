/**
 * 0DTE Signal Generator
 * Determines when and what credit spreads to open
 *
 * Strategy: Sell OTM credit spreads on SPY after morning volatility settles.
 * - Put credit spreads (bullish) when SPY trending up or neutral
 * - Call credit spreads (bearish) when SPY trending down or neutral
 * - Iron condors (both sides) in low-vol / range-bound days
 */

import config from './config.js';

// Track intraday price action for signal generation
const priceHistory = [];
const MAX_HISTORY = 120; // ~60 min at 30s intervals

export function recordPrice(price, timestamp = Date.now()) {
  priceHistory.push({ price, timestamp });
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
}

/**
 * Determine the current market bias from recent price action
 * Returns: 'bullish' | 'bearish' | 'neutral'
 */
export function getMarketBias() {
  if (priceHistory.length < 10) return 'neutral'; // not enough data

  const recent = priceHistory.slice(-10);
  const older = priceHistory.slice(-30, -10);

  if (!older.length) return 'neutral';

  const recentAvg = recent.reduce((s, p) => s + p.price, 0) / recent.length;
  const olderAvg = older.reduce((s, p) => s + p.price, 0) / older.length;
  const pctChange = ((recentAvg - olderAvg) / olderAvg) * 100;

  if (pctChange > 0.05) return 'bullish';
  if (pctChange < -0.05) return 'bearish';
  return 'neutral';
}

/**
 * Calculate implied volatility rank approximation from price movement
 * Used to size positions — higher vol = wider spreads, smaller size
 */
export function getIntradayVolatility() {
  if (priceHistory.length < 20) return 'normal';

  const prices = priceHistory.slice(-60).map(p => p.price);
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const stdDev = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);

  // Annualized vol approximation (very rough for intraday)
  if (stdDev > 0.002) return 'high';    // >0.2% per 30s = volatile day
  if (stdDev > 0.001) return 'normal';
  return 'low';
}

/**
 * Select strikes for a credit spread given the option chain
 *
 * @param {Array} strikes - available strikes from the chain
 * @param {number} spotPrice - current SPY price
 * @param {string} type - 'put' or 'call'
 * @param {number} targetDelta - target delta for short strike (e.g. 10)
 * @param {number} width - spread width in dollars (e.g. 1)
 * @returns {{ shortStrike, longStrike, estimatedCredit }}
 */
export function selectStrikes(strikes, spotPrice, type, targetDelta, width) {
  // Without real-time greeks, approximate delta by distance from spot
  // ~10 delta put ≈ 1.5-2% OTM, ~10 delta call ≈ 1.5-2% OTM
  // This is a rough heuristic — the bot will refine with actual greeks from the chain

  const otmPct = targetDelta <= 10 ? 0.015 : targetDelta <= 16 ? 0.01 : 0.005;

  let shortStrike, longStrike;

  if (type === 'put') {
    // Put credit spread: sell higher put, buy lower put
    const target = spotPrice * (1 - otmPct);
    shortStrike = roundToStrike(target, strikes);
    longStrike = shortStrike - width;
  } else {
    // Call credit spread: sell lower call, buy higher call
    const target = spotPrice * (1 + otmPct);
    shortStrike = roundToStrike(target, strikes);
    longStrike = shortStrike + width;
  }

  // Verify both strikes exist in chain
  const strikeValues = strikes.map(s =>
    typeof s === 'number' ? s : parseFloat(s['strike-price'] || s.strike || s)
  );

  if (!strikeValues.includes(shortStrike) || !strikeValues.includes(longStrike)) {
    // Find nearest valid strikes
    shortStrike = findNearest(strikeValues, shortStrike);
    if (type === 'put') {
      longStrike = findNearest(strikeValues.filter(s => s < shortStrike), shortStrike - width);
    } else {
      longStrike = findNearest(strikeValues.filter(s => s > shortStrike), shortStrike + width);
    }
  }

  // Rough credit estimate: $1 wide spread at 10 delta ≈ $0.15-0.30 credit
  const distFromSpot = Math.abs(spotPrice - shortStrike) / spotPrice;
  const estimatedCredit = Math.max(0.05, 0.30 - distFromSpot * 10);

  return { shortStrike, longStrike, estimatedCredit: Math.round(estimatedCredit * 100) / 100 };
}

/**
 * Generate trading signals for current market conditions
 * Returns array of signals to potentially execute
 */
export function generateSignals(spotPrice, chain0DTE, openPositions) {
  const signals = [];
  const now = new Date();
  const etHour = getETHour(now);
  const etMinute = getETMinute(now);
  const minutesSinceOpen = (etHour - 9) * 60 + (etMinute - 30);

  // Don't trade before entry window
  if (minutesSinceOpen < config.entryAfterMinutes) {
    return signals;
  }

  // Don't open new positions in last 90 min (let existing ones run or close)
  if (minutesSinceOpen > 300) { // after 2:30 PM ET
    return signals;
  }

  // Don't exceed max positions
  if (openPositions.length >= config.maxOpenPositions) {
    return signals;
  }

  const bias = getMarketBias();
  const vol = getIntradayVolatility();

  // Extract strike values from chain
  const strikes = extractStrikes(chain0DTE);
  if (!strikes.length) return signals;

  // Adjust delta target based on volatility
  let delta = config.targetDelta;
  if (vol === 'high') delta = Math.max(5, delta - 3);  // go further OTM in high vol
  if (vol === 'low') delta = Math.min(16, delta + 3);   // tighter in low vol

  // Generate spread signals based on bias
  if (bias === 'bullish' || bias === 'neutral') {
    // Sell put credit spread (bullish bet)
    const spread = selectStrikes(strikes, spotPrice, 'put', delta, config.spreadWidth);
    if (spread.shortStrike && spread.longStrike && spread.estimatedCredit >= 0.10) {
      signals.push({
        type: 'put',
        side: 'PUT_CREDIT_SPREAD',
        shortStrike: spread.shortStrike,
        longStrike: spread.longStrike,
        estimatedCredit: spread.estimatedCredit,
        reason: `${bias} bias, ${vol} vol, ~${delta}Δ`,
      });
    }
  }

  if (bias === 'bearish' || bias === 'neutral') {
    // Sell call credit spread (bearish bet)
    const spread = selectStrikes(strikes, spotPrice, 'call', delta, config.spreadWidth);
    if (spread.shortStrike && spread.longStrike && spread.estimatedCredit >= 0.10) {
      signals.push({
        type: 'call',
        side: 'CALL_CREDIT_SPREAD',
        shortStrike: spread.shortStrike,
        longStrike: spread.longStrike,
        estimatedCredit: spread.estimatedCredit,
        reason: `${bias} bias, ${vol} vol, ~${delta}Δ`,
      });
    }
  }

  return signals;
}

/**
 * Check if any open positions should be closed
 * Returns array of close signals
 */
export function checkExits(openTrades, currentPrices) {
  const closeSignals = [];
  const now = new Date();
  const etHour = getETHour(now);
  const etMinute = getETMinute(now);
  const minutesToClose = (16 - etHour) * 60 - etMinute;

  for (const trade of openTrades) {
    const currentValue = currentPrices[trade.id] || null;
    if (!currentValue) continue;

    const creditReceived = trade.creditReceived;
    const currentCost = currentValue; // cost to close
    const pnl = creditReceived - currentCost;
    const pnlPct = (pnl / creditReceived) * 100;

    // Take profit: close at target %
    if (pnlPct >= config.profitTargetPct) {
      closeSignals.push({
        trade,
        reason: `PROFIT_TARGET: ${pnlPct.toFixed(0)}% gain (${pnl.toFixed(2)} credit)`,
        debitLimit: currentCost,
      });
      continue;
    }

    // Stop loss: close if loss exceeds multiplier of credit
    const maxLoss = creditReceived * config.stopLossMultiplier;
    if (currentCost > creditReceived + maxLoss) {
      closeSignals.push({
        trade,
        reason: `STOP_LOSS: cost to close $${currentCost.toFixed(2)} > max $${(creditReceived + maxLoss).toFixed(2)}`,
        debitLimit: currentCost * 1.05, // slight buffer to ensure fill
      });
      continue;
    }

    // Time exit: close 15 min before market close
    if (minutesToClose <= config.exitBeforeMinutes) {
      closeSignals.push({
        trade,
        reason: `TIME_EXIT: ${minutesToClose}min to close`,
        debitLimit: currentCost * 1.05,
      });
      continue;
    }
  }

  return closeSignals;
}

// ── Helpers ─────────────────────────────────────────────────

function roundToStrike(target, strikes) {
  const values = strikes.map(s =>
    typeof s === 'number' ? s : parseFloat(s['strike-price'] || s.strike || s)
  );
  return findNearest(values, target);
}

function findNearest(arr, target) {
  if (!arr.length) return null;
  return arr.reduce((prev, curr) =>
    Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
  );
}

function extractStrikes(chain) {
  if (!chain) return [];
  // Handle nested chain format from Tastytrade
  if (Array.isArray(chain)) {
    return chain.map(s =>
      typeof s === 'number' ? s : parseFloat(s['strike-price'] || s.strike || s)
    ).filter(s => !isNaN(s));
  }
  if (chain.strikes) return extractStrikes(chain.strikes);
  if (chain['strike-prices']) return extractStrikes(chain['strike-prices']);
  return [];
}

function getETHour(date) {
  return parseInt(date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
}

function getETMinute(date) {
  return parseInt(date.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
}
