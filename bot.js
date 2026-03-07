/**
 * Main bot loop.
 * Polls configured markets, detects Kalshi vs Polymarket divergence,
 * trades on Kalshi only using Polymarket as a price signal.
 */

import fs from 'fs';
import { config, loadApprovedMarkets } from './config.js';
import { initClients, fetchMarketPrices, fetchKalshiMarket, getKalshiClient } from './fetcher.js';
import { findDivergence, shouldExitPosition } from './arbitrage.js';
import { enterPosition, exitPosition } from './executor.js';

const TRADES_FILE = './trades.json';

/**
 * Persistent trade ledger — survives restarts.
 * Each entry: { ticker, side, entryPrice, limitPrice, contracts, entryTime, status }
 * status: 'open' | 'closed'
 */
function loadTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); }
  catch { return []; }
}

function saveTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function recordTrade(ticker, side, entryPrice, limitPrice, contracts) {
  const trades = loadTrades();
  trades.push({
    ticker, side, entryPrice, limitPrice, contracts,
    entryTime: new Date().toISOString(),
    status: 'open',
  });
  saveTrades(trades);
  console.log(`[trades] Saved: ${ticker} ${side.toUpperCase()} ${contracts}x @ ${(entryPrice*100).toFixed(1)}c`);
}

function closeTrade(ticker, sellPrice, pnl) {
  const trades = loadTrades();
  const trade = trades.find(t => t.ticker === ticker && t.status === 'open');
  if (trade) {
    trade.status = 'closed';
    trade.sellPrice = sellPrice;
    trade.pnl = pnl;
    trade.closeTime = new Date().toISOString();
    saveTrades(trades);
  }
}

function getOpenTrade(ticker) {
  return loadTrades().find(t => t.ticker === ticker && t.status === 'open');
}

const positions = [];
const closedPnl = [];

// ANSI colors for trade highlights
const C = {
  buy:   '\x1b[1;36m',  // bold cyan
  sell:  '\x1b[1;35m',  // bold magenta
  win:   '\x1b[1;32m',  // bold green
  loss:  '\x1b[1;31m',  // bold red
  reset: '\x1b[0m',
};

// --- Sports momentum scanner ---
// Price history: ticker -> [{price, time}]
const priceHistory = new Map();
// Active momentum positions: ticker -> {entryPrice, highestSeen, entryTime}
const momentumPositions = new Map();

// Entry signals
const MOMENTUM_MIN_MOVE = 0.05;        // 5c momentum move required
const MOMENTUM_WINDOW_MS = 5 * 60 * 1000; // momentum: within 5 minutes
const MOMENTUM_MIN_PRICE = 0.55;       // momentum: don't buy below 55c
const MOMENTUM_MAX_PRICE = 0.60;       // momentum: don't buy above 60c (better risk/reward)
const REVERSION_DIP = 0.05;            // mean reversion: 5c dip from avg
const REVERSION_AVG_WINDOW_MS = 30 * 60 * 1000; // mean reversion: 30min avg
const REVERSION_MIN_PRICE = 0.55;      // mean reversion: only favorites 55c+
const REVERSION_MAX_PRICE = 0.80;      // mean reversion: cap at 80c

// Exit thresholds
const MOMENTUM_STOP_LOSS = 0.10;       // sell if price drops 10c below entry
const MOMENTUM_TRAILING_STOP = 0.05;   // sell if price drops 5c from peak
const MOMENTUM_TAKE_PROFIT = 0.15;     // sell if price rises 15c above entry

// Filters
const MOMENTUM_CONTRACTS = 1;          // test with 1 contract
const MOMENTUM_MAX_HOURS = 48;         // markets closing within 48h
const MOMENTUM_MIN_BID_DEPTH = 3;      // min bid-side contracts for liquidity
const MOMENTUM_MIN_VOLUME = 20;        // min contracts traded on ticker before entering
const MOMENTUM_MAX_PER_GAME = 2;       // max tickers per game session
const MOMENTUM_SKIP_PREFIXES = ['KXMVE', 'KXNCAABB']; // skip parlays and NCAA basketball

export async function startBot() {
  console.log('\n================================================');
  console.log('  Signal BonBon — Sports Momentum Trader v1.1');
  console.log('================================================');
  console.log(`Mode:           ${config.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Poll interval:  ${config.pollIntervalSeconds}s`);
  console.log(`Min divergence: ${config.minDivergenceBps} bps`);
  console.log(`Min IRR:        ${config.minIRR}%`);
  console.log(`Position size:  $${config.positionSizeUSD}`);
  console.log(`Max positions:  ${config.maxOpenPositions}`);
  console.log(`Markets:        ${config.markets.length}\n`);

  initClients();

  while (true) {
    const cycleStart = Date.now();
    await poll();
    const elapsed = Date.now() - cycleStart;
    const remaining = Math.max(0, config.pollIntervalSeconds * 1000 - elapsed);
    if (remaining > 0) await sleep(remaining);
  }
}

async function poll() {
  // Pick up any newly approved markets from the dashboard
  loadApprovedMarkets();

  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n--- ${timestamp} ---`);

  // 1. Fetch market prices sequentially to avoid Kalshi 429 rate limits
  const snapshots = [];
  for (const m of config.markets) {
    snapshots.push(await fetchMarketPrices(m));
    await sleep(1500);
  }

  // 2. Compute divergences
  const signals = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const market = config.markets[i];

    if (snap.kalshiPrice === null || snap.polyPrice === null) {
      console.log(`[scan]    ${market.label}: Missing prices (K=${snap.kalshiPrice} P=${snap.polyPrice})`);
      continue;
    }

    const sig = findDivergence(snap.polyPrice, snap.kalshiPrice, snap.kalshiSide, snap.daysToExpiry);
    sig.marketLabel = market.label;
    sig.marketIndex = i;

    const meets = sig.divergenceBps >= config.minDivergenceBps && sig.irr >= config.minIRR;
    const marker = meets ? '>>' : '  ';
    console.log(
      `[scan] ${marker} ${market.label.padEnd(28)} ` +
      `K=${(snap.kalshiPrice * 100).toFixed(1)}c  P=${(snap.polyPrice * 100).toFixed(1)}c  ` +
      `div=${sig.divergenceBps.toFixed(0)}bps  IRR=${sig.irr.toFixed(0)}%  ` +
      `-> BUY ${sig.tradeSide.toUpperCase()} @ ${(sig.entryPrice * 100).toFixed(1)}c  ${snap.daysToExpiry}d`
    );

    if (meets) signals.push({ ...sig, market });
  }

  signals.sort((a, b) => b.irr - a.irr);

  // 3. Check exits for open positions
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    const snap = snapshots[pos.marketIndex];
    if (!snap || snap.kalshiPrice === null || snap.polyPrice === null) continue;

    const current = findDivergence(snap.polyPrice, snap.kalshiPrice, snap.kalshiSide, snap.daysToExpiry);

    const { shouldExit, reason } = shouldExitPosition(
      pos, current.divergenceBps, current.divergence, current.irr,
      config.exitConvergenceBps, config.minIRR
    );

    if (shouldExit) {
      pos.exitReason = reason;
      pos.exitTime = new Date().toISOString();
      // Estimate PnL: current price of our side minus what we paid
      const currentPrice = pos.tradeSide === 'yes'
        ? snap.kalshiYes
        : snap.kalshiNo;
      pos.realizedPnl = (currentPrice - pos.entryPrice) * pos.contracts;

      await exitPosition(pos, config.markets[pos.marketIndex]);
      closedPnl.push(pos);
      positions.splice(i, 1);

      console.log(`[exit] ${pos.marketLabel} | ${reason} | PnL: ${pos.realizedPnl >= 0 ? '+' : ''}$${pos.realizedPnl.toFixed(2)}`);
    }
  }

  // Fetch open orders once — used by both auto-sell (3b) and buy (4)
  let openSellTickers = new Set();
  let openOrderTickers = new Set();  // ALL open orders (buy + sell) — block re-buying
  try {
    const openOrders = await getKalshiClient().fetchOpenOrders();
    for (const o of openOrders) {
      openOrderTickers.add(o.marketId);
      if (o.side === 'sell') openSellTickers.add(o.marketId);
    }
  } catch (e) {
    console.warn(`[orders] Could not fetch open orders: ${e.message}`);
  }

  // Track tickers sold this cycle — prevent re-buying in step 4
  const soldThisCycle = new Set();

  // 3b. Auto-sell: check real Kalshi positions, sell if bid > entry price
  try {
    // Fetch positions via raw Kalshi API to get all fields (pmxt strips some)
    let rawPositions = null;
    try {
      rawPositions = await getKalshiClient().callApi('GetPositions', { limit: 100, settlement_status: 'unsettled' });
      // Build lookup map for raw position data

    } catch (e) {
      console.warn(`[auto-sell] Raw positions API failed: ${e.message}`);
    }

    const livePositions = await getKalshiClient().fetchPositions();

    // Merge raw position data (especially average prices) into pmxt positions
    const rawMap = new Map();
    for (const rp of (rawPositions?.market_positions || [])) {
      rawMap.set(rp.ticker || rp.market_ticker, rp);
    }

    for (const pos of livePositions) {
      // size is signed: positive = Yes, negative = No, zero = no position
      if (pos.size === 0) continue;
      const posSize = Math.abs(pos.size);

      // Skip if there's already a pending sell order for this market
      if (openSellTickers.has(pos.marketId)) continue;

      const ticker = pos.marketId;

      // Fetch the correct market using the validated fetcher (pmxt's raw
      // fetchMarkets returns WRONG markets for some tickers — it returned
      // KXELONMARS-99 for KXFED tickers, causing sells on the wrong market)
      let market = null;
      try {
        const markets = await fetchKalshiMarket(ticker);
        market = markets[0] ?? null;
      } catch (e) {
        console.warn(`[auto-sell] Failed to fetch market ${ticker}: ${e.message}`);
      }
      if (!market) { console.warn(`[auto-sell] ${ticker}: market not found, skipping`); continue; }

      // CRITICAL: verify the returned market actually matches our ticker
      if (market.marketId !== ticker) {
        console.error(`[auto-sell] WRONG MARKET: asked for ${ticker}, got ${market.marketId} — SKIPPING`);
        continue;
      }

      // Determine which outcome we hold (yes vs no).
      // pmxt sets outcomeId to the ticker for ALL outcomes, so matching by
      // outcomeId always returns index 0 (yes). Use the raw Kalshi position
      // data instead: position > 0 = yes, position < 0 = no.
      const outcomes = market.outcomes || [];
      let side = 'yes';
      const raw = rawMap.get(ticker);
      if (raw && raw.position < 0) {
        side = 'no';
      }
      let outcome = side === 'no' ? (outcomes[1] || outcomes[0]) : outcomes[0];

      if (!outcome) { console.warn(`[auto-sell] ${ticker}: no outcomes found`); continue; }

      // Fetch order book via Kalshi REST API directly (pmxt's fetchOrderBook
      // fails with DECODER error due to key format issues)
      let bestBid = null;
      try {
        const obUrl = `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`;
        const obResp = await fetch(obUrl);
        if (obResp.ok) {
          const obData = await obResp.json();
          const ob = obData.orderbook || obData;
          // Kalshi orderbook: "yes" and "no" arrays of [price_cents, quantity]
          // sorted ASCENDING — best bid (highest price) is the LAST element
          const yesBids = ob.yes || [];
          const noBids = ob.no || [];

          // Only use direct bids — someone actually willing to buy our side.
          // Cross-side inference is unreliable (a 1c NO bid ≠ a 99c YES buyer).
          if (side === 'yes' && yesBids.length) {
            bestBid = yesBids[yesBids.length - 1][0] / 100;
          } else if (side === 'no' && noBids.length) {
            bestBid = noBids[noBids.length - 1][0] / 100;
          }

        } else {
          console.warn(`[auto-sell] ${ticker} orderbook HTTP ${obResp.status}`);
        }
      } catch (e) {
        console.warn(`[auto-sell] ${ticker} orderbook error: ${e.message}`);
      }
      await sleep(1500);

      // Look up entry price: manual overrides → trade ledger → API → Kalshi fills
      let entry = null;
      const isAccidentalPosition = ticker === 'KXFED-26JUN-T4.50';

      // 1. Manual entry prices (entry-prices.json, values in cents)
      try {
        const manual = JSON.parse(fs.readFileSync('./entry-prices.json', 'utf8'));
        if (manual[ticker] != null) {
          entry = manual[ticker] / 100; // cents to decimal
        }
      } catch {}

      // 2. Trade ledger
      if (entry == null) {
        const savedTrade = getOpenTrade(ticker);
        entry = savedTrade?.entryPrice ?? null;
      }

      // 3. Kalshi API position entry price (pmxt)
      if (entry == null && pos.entryPrice > 0) {
        entry = pos.entryPrice;
      }

      // 3b. Raw Kalshi position data — calculate avg entry from market_exposure / position
      // position is positive for Yes, negative for No; use abs value for the calc
      if (entry == null) {
        if (raw && raw.market_exposure > 0 && raw.position !== 0) {
          entry = (raw.market_exposure / Math.abs(raw.position)) / 100; // cents to decimal
        }
      }

      // 4. Kalshi fill history
      if (entry == null && !isAccidentalPosition) {
        try {
          const fills = await getKalshiClient().callApi('GetFills', { ticker, limit: 100 });
          const allFills = fills?.fills || [];
          const buyFills = allFills.filter(f => f.action === 'buy');
          if (buyFills.length) {
            // Use the correct price field for our side — yes_price and no_price
            // are BOTH set on every fill (summing to 100), so yes_price || no_price
            // always returns yes_price, which is WRONG for No positions.
            const totalCost = buyFills.reduce((s, f) => {
              const price = side === 'no' ? (f.no_price || f.yes_price || 0) : (f.yes_price || f.no_price || 0);
              return s + price * (f.count || 1);
            }, 0);
            const totalQty = buyFills.reduce((s, f) => s + (f.count || 1), 0);
            entry = totalCost / totalQty / 100;
          }
        } catch (e) {
          console.warn(`[auto-sell] ${ticker}: could not fetch fills: ${e.message}`);
        }
        await sleep(500);
      }

      let minSellPrice;
      if (entry != null && entry > 0) {
        // Kalshi taker fee is ~0.7c/contract each side, so round-trip ~1.4c.
        // Require at least 3c above entry to guarantee profit after fees.
        // (or accept 5c loss for accidental positions we're trying to exit)
        const minProfitCents = isAccidentalPosition ? -5 : 3;
        minSellPrice = Math.round((entry + minProfitCents / 100) * 100) / 100;
      } else if (isAccidentalPosition) {
        minSellPrice = 0.01;
      } else {
        // Still no entry price — hold, don't sell blind
        continue;
      }

      if (bestBid == null) continue;

      // Decide whether to sell
      let sellReason = null;
      if (bestBid >= 0.95) {
        sellReason = `bid ${(bestBid*100).toFixed(0)}c >= 95c (near-certain)`;
      } else if (bestBid >= minSellPrice) {
        sellReason = `bid ${(bestBid*100).toFixed(0)}c >= min ${(minSellPrice*100).toFixed(0)}c`;
      }
      if (!sellReason) continue;

      // Place limit sell at the best bid price to fill immediately
      // Cap at 25 contracts per order (same as buy side) — remainder sells next cycle
      const sellPrice = bestBid;
      const sellQty = Math.min(posSize, 25);
      console.log(`${C.sell}[auto-sell] SELL ${ticker} ${side.toUpperCase()} ${sellQty}x @ ${(sellPrice*100).toFixed(0)}c | ${sellReason}${C.reset}`);

      if (config.dryRun) {
        console.log(`[auto-sell]   -> DRY RUN: would sell`);
        continue;
      }

      // Use Kalshi REST API directly via pmxtjs callApi — the high-level
      // createOrder swallows error details and fails on sells
      const kalshiOrderBody = {
        ticker,
        action: 'sell',
        side: side,      // 'yes' or 'no'
        type: 'limit',
        count: sellQty,
        ...(side === 'yes'
          ? { yes_price: Math.round(sellPrice * 100) }
          : { no_price: Math.round(sellPrice * 100) }),
      };

      try {
        const order = await getKalshiClient().callApi('CreateOrder', kalshiOrderBody);
        const fillCount = order?.order?.fill_count ?? sellQty;
        const fees = parseFloat(order?.order?.taker_fees_dollars || '0');
        const pnl = entry ? (sellPrice - entry) * fillCount - fees : null;
        const pnlColor = pnl != null && pnl >= 0 ? C.win : C.loss;
        console.log(
          `${C.sell}[auto-sell]   -> SOLD ${fillCount} contracts` +
          (pnl != null ? ` | ${pnlColor}PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (after $${fees.toFixed(2)} fees)${C.sell}` : '') +
          C.reset
        );
        soldThisCycle.add(ticker);
        // Record in trade ledger — create entry if none exists (manual buys)
        const existingTrade = getOpenTrade(ticker);
        if (!existingTrade && entry) {
          recordTrade(ticker, side, entry, entry, fillCount);
        }
        closeTrade(ticker, sellPrice, pnl);
      } catch (e) {
        console.error(`[auto-sell]   -> sell failed: ${e.message}`);
      }
      await sleep(1500);
    }
  } catch (e) {
    console.warn(`[auto-sell] Failed to check positions: ${e.message}`);
  }

  // 4. Enter new positions
  // Fetch real Kalshi positions AND check trade ledger to avoid re-buying
  const openTrades = loadTrades().filter(t => t.status === 'open');
  let liveTickerSet = new Set(openTrades.map(t => t.ticker));
  try {
    const livePositions = await getKalshiClient().fetchPositions();
    for (const p of livePositions) {
      if (p.size !== 0) liveTickerSet.add(p.marketId);
    }
    // Also block buys for tickers with ANY pending orders (buy or sell)
    for (const t of openOrderTickers) liveTickerSet.add(t);
    // Block re-buying tickers we just sold this cycle
    for (const t of soldThisCycle) liveTickerSet.add(t);
    if (liveTickerSet.size > 0) {
      console.log(`[positions] Holding ${liveTickerSet.size} tickers`);
    }
  } catch (e) {
    console.warn(`[positions] Could not fetch live positions: ${e.message}`);
  }

  // 4b. Sports momentum scanner
  await scanSportsMomentum(liveTickerSet);

  for (const sig of signals) {
    if (positions.length >= config.maxOpenPositions) break;
    const alreadyOpen = positions.some(p => p.marketLabel === sig.marketLabel);
    if (alreadyOpen) continue;

    // Check if we already hold this ticker on Kalshi (survives bot restarts)
    if (liveTickerSet.has(sig.market.kalshiTicker)) {
      console.log(`[skip] ${sig.marketLabel}: already holding position on Kalshi`);
      continue;
    }

    // Use the limit price (entry + 1c buffer) for cost calculation
    const limitPrice = Math.round((sig.entryPrice + 0.01) * 100) / 100;
    const contracts = Math.floor(config.positionSizeUSD / limitPrice);
    if (contracts < 1) continue;

    const result = await enterPosition(sig, sig.market, contracts);

    if (result.success && !result.dryRun) {
      // Persist trade to disk so we know the entry price after restarts
      recordTrade(sig.market.kalshiTicker, sig.tradeSide, sig.entryPrice, limitPrice, contracts);

      positions.push({
        marketLabel: sig.marketLabel,
        marketIndex: sig.marketIndex,
        tradeSide: sig.tradeSide,
        entryPrice: sig.entryPrice,
        entryDivergence: sig.divergence,
        entryDivergenceBps: sig.divergenceBps,
        entryIRR: sig.irr,
        contracts,
        entryTime: new Date().toISOString(),
      });
    }
  }

  // 5. Detect settled positions — close open trades that are no longer held
  let liveCount = 0;
  const liveTickersNow = new Set();
  try {
    const live = await getKalshiClient().fetchPositions();
    for (const p of live) {
      if (p.size !== 0) {
        liveCount++;
        liveTickersNow.add(p.marketId);
      }
    }
  } catch {}

  const allTrades = loadTrades();
  const openTrades2 = allTrades.filter(t => t.status === 'open');
  for (const trade of openTrades2) {
    // If we still hold it or just sold it this cycle, skip
    if (liveTickersNow.has(trade.ticker) || soldThisCycle.has(trade.ticker)) continue;
    // Position is gone — likely settled. Check the market result.
    let pnl = -(trade.entryPrice * (trade.contracts || 1)); // assume total loss
    try {
      const mktResp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${trade.ticker}`);
      if (mktResp.ok) {
        const mktData = await mktResp.json();
        const mkt = mktData.market || mktData;
        const result = mkt.result;
        if (result === 'yes' && trade.side === 'yes') {
          pnl = (1 - trade.entryPrice) * (trade.contracts || 1);
        } else if (result === 'no' && trade.side === 'no') {
          pnl = (1 - trade.entryPrice) * (trade.contracts || 1);
        }
        // If result matches our side, we won; otherwise pnl stays as total loss
        const sc = pnl >= 0 ? C.win : C.loss;
        console.log(`${sc}[settle] ${trade.ticker} ${trade.side.toUpperCase()} | result=${result || '?'} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}${C.reset}`);
      }
    } catch (e) {
      console.warn(`[settle] ${trade.ticker}: could not fetch market: ${e.message}`);
    }
    closeTrade(trade.ticker, 0, pnl);
    await sleep(500);
  }

  // 6. Summary
  const allTrades2 = loadTrades();
  const stillOpen = allTrades2.filter(t => t.status === 'open');
  const closedTrades = allTrades2.filter(t => t.status === 'closed');
  const realizedPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);

  console.log(
    `\n[summary] Positions: ${liveCount}  Ledger open: ${stillOpen.length}  Closed: ${closedTrades.length}  ` +
    `Realized PnL: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`
  );
}

/**
 * Sports momentum scanner with mean reversion, stop-loss, trailing stop,
 * liquidity checks, time-to-close weighting, and cross-game dedup.
 */
async function scanSportsMomentum(liveTickerSet) {
  try {
    const now = Date.now();
    const minClose = Math.floor((now - 60 * 1000) / 1000);
    const maxClose = Math.floor((now + MOMENTUM_MAX_HOURS * 60 * 60 * 1000) / 1000);
    const url = `https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&status=open&min_close_ts=${minClose}&max_close_ts=${maxClose}`;

    const resp = await fetch(url);
    if (!resp.ok) { console.log(`[momentum] Kalshi API ${resp.status}`); return; }
    const data = await resp.json();
    const markets = data.markets || [];
    if (!markets.length) { console.log(`[momentum] No markets closing within ${MOMENTUM_MAX_HOURS}h`); return; }

    // Build a price lookup from the fetched markets for exit checks
    const currentPrices = new Map();
    for (const m of markets) {
      if (!m.ticker) continue;
      const p = (m.yes_ask > 1 ? m.yes_ask : (m.last_price || 0)) / 100;
      if (p > 0) currentPrices.set(m.ticker, p);
    }

    // --- Step 1: Check exits for active momentum positions ---
    let exits = 0;
    for (const [ticker, mp] of momentumPositions) {
      const curPrice = currentPrices.get(ticker);
      if (curPrice == null) continue;

      // Update highest seen price (for trailing stop)
      if (curPrice > mp.highestSeen) mp.highestSeen = curPrice;

      let exitReason = null;
      if (curPrice <= mp.entryPrice - MOMENTUM_STOP_LOSS) {
        exitReason = `STOP-LOSS (${(curPrice*100).toFixed(0)}c, entry ${(mp.entryPrice*100).toFixed(0)}c)`;
      } else if (curPrice <= mp.highestSeen - MOMENTUM_TRAILING_STOP) {
        exitReason = `TRAILING-STOP (${(curPrice*100).toFixed(0)}c, peak ${(mp.highestSeen*100).toFixed(0)}c)`;
      } else if (curPrice >= mp.entryPrice + MOMENTUM_TAKE_PROFIT) {
        exitReason = `TAKE-PROFIT (${(curPrice*100).toFixed(0)}c, entry ${(mp.entryPrice*100).toFixed(0)}c)`;
      }

      if (!exitReason) continue;
      console.log(`[momentum] EXIT ${ticker}: ${exitReason}`);

      if (config.dryRun) {
        console.log(`[momentum]    DRY RUN: would sell`);
        momentumPositions.delete(ticker);
        continue;
      }

      // Sell at current price (limit at curPrice - 1c to ensure fill)
      const sellPrice = Math.max(1, Math.round((curPrice - 0.01) * 100));
      try {
        await getKalshiClient().callApi('CreateOrder', {
          ticker, action: 'sell', side: 'yes', type: 'limit',
          count: MOMENTUM_CONTRACTS, yes_price: sellPrice,
        });
        const pnl = (curPrice - mp.entryPrice - 0.01) * MOMENTUM_CONTRACTS;
        const pnlColor = pnl >= 0 ? C.win : C.loss;
        console.log(`${C.sell}[momentum]    SOLD @ ${sellPrice}c | ${pnlColor}PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}${C.reset}`);
        closeTrade(ticker, curPrice, pnl);
        exits++;
      } catch (e) {
        console.error(`[momentum]    Sell failed: ${e.message}`);
      }
      momentumPositions.delete(ticker);
      await sleep(1500);
    }

    // --- Step 2: Scan for new signals ---
    console.log(`[momentum] Scanning ${markets.length} markets (${momentumPositions.size} active, ${exits} exited)`);

    let signals = 0;
    const nowMs = Date.now();

    // Game session ID: extract date+time+teams portion to catch cross-market-type
    // correlation (e.g., KXWBCTOTAL and KXWBCSPREAD for the same game).
    // Matches patterns like 26MAR061900NICDOM from the ticker.
    const gameSession = (t) => {
      const m = t.match(/(\d{2}[A-Z]{3}\d{4,6}[A-Z]{2,})/);
      return m ? m[1] : t;
    };

    // Build map of game sessions we already hold or bought -> count of tickers
    const heldGames = new Set();
    const gameSessionCount = new Map();
    for (const t of liveTickerSet) {
      const gs = gameSession(t);
      heldGames.add(gs);
      gameSessionCount.set(gs, (gameSessionCount.get(gs) || 0) + 1);
    }
    const boughtGames = new Set();

    for (const m of markets) {
      const ticker = m.ticker;
      if (!ticker) continue;
      if (MOMENTUM_SKIP_PREFIXES.some(p => ticker.startsWith(p))) continue;

      const yesPrice = currentPrices.get(ticker);
      if (!yesPrice || yesPrice < 0.05) continue;

      // Update price history (keep 2x the longer window for mean reversion)
      if (!priceHistory.has(ticker)) priceHistory.set(ticker, []);
      const history = priceHistory.get(ticker);
      history.push({ price: yesPrice, time: nowMs });
      while (history.length > 0 && history[0].time < nowMs - REVERSION_AVG_WINDOW_MS * 2) {
        history.shift();
      }

      if (history.length < 2) continue;

      // --- Signal detection ---
      let signalType = null;
      let signalDetail = '';

      // A) Momentum: 5c+ rise in 5 minutes, price 55-70c
      const momentumStart = nowMs - MOMENTUM_WINDOW_MS;
      const oldEntry = history.find(h => h.time >= momentumStart) || history[0];
      const priceMove = yesPrice - oldEntry.price;

      if (priceMove >= MOMENTUM_MIN_MOVE && yesPrice >= MOMENTUM_MIN_PRICE && yesPrice <= MOMENTUM_MAX_PRICE) {
        signalType = 'MOMENTUM';
        signalDetail = `${(oldEntry.price*100).toFixed(0)}c->${(yesPrice*100).toFixed(0)}c (+${(priceMove*100).toFixed(0)}c/${Math.round((nowMs-oldEntry.time)/1000)}s)`;
      }

      // B) Mean reversion: favorite (55-80c avg) dips 5c+ below 30min average
      if (!signalType) {
        const avgWindow = history.filter(h => h.time >= nowMs - REVERSION_AVG_WINDOW_MS);
        if (avgWindow.length >= 3) {
          const avg = avgWindow.reduce((s, h) => s + h.price, 0) / avgWindow.length;
          const dip = avg - yesPrice;
          if (dip >= REVERSION_DIP && avg >= REVERSION_MIN_PRICE && avg <= REVERSION_MAX_PRICE) {
            signalType = 'REVERSION';
            signalDetail = `avg ${(avg*100).toFixed(0)}c, now ${(yesPrice*100).toFixed(0)}c (dip ${(dip*100).toFixed(0)}c)`;
          }
        }
      }

      if (!signalType) continue;

      // --- Filters ---
      // Skip if we already hold this ticker or hit the per-game cap
      const gs = gameSession(ticker);
      if (liveTickerSet.has(ticker) || boughtGames.has(gs)) continue;
      const gsCount = gameSessionCount.get(gs) || 0;
      if (gsCount >= MOMENTUM_MAX_PER_GAME) continue;

      // Time-to-close: prefer markets closing sooner (more reliable signal)
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : 0;
      const hoursToClose = closeTime ? (closeTime - nowMs) / (1000 * 60 * 60) : 999;
      // Skip if closing > 6h away (signal less reliable for distant games)
      if (hoursToClose > 6) continue;

      // Liquidity check: fetch orderbook, require min bid depth
      let bestBid = null;
      let bidDepth = 0;
      try {
        const obResp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`);
        if (obResp.ok) {
          const obData = await obResp.json();
          const ob = obData.orderbook || obData;
          const yesBids = ob.yes || [];
          bidDepth = yesBids.reduce((s, lvl) => s + lvl[1], 0);
          if (yesBids.length) bestBid = yesBids[yesBids.length - 1][0] / 100;
        }
      } catch {}
      await sleep(500);

      if (bidDepth < MOMENTUM_MIN_BID_DEPTH) {
        // Not enough liquidity to exit
        continue;
      }

      // Volume check: require enough trades to confirm game is in progress
      const volume = m.volume || 0;
      if (volume < MOMENTUM_MIN_VOLUME) {
        continue;
      }

      signals++;
      const title = (m.title || m.subtitle || ticker).substring(0, 50);
      const closesIn = hoursToClose < 1 ? `${Math.round(hoursToClose*60)}min` : `${hoursToClose.toFixed(1)}h`;
      console.log(
        `[momentum] >> ${signalType}: ${title} | ${ticker}\n` +
        `[momentum]    ${signalDetail} | bid=${bestBid ? (bestBid*100).toFixed(0)+'c' : '?'} depth=${bidDepth} vol=${m.volume || 0} | closes ${closesIn}`
      );

      if (config.dryRun) {
        console.log(`[momentum]    DRY RUN: would buy ${MOMENTUM_CONTRACTS} YES @ ${(yesPrice*100).toFixed(0)}c`);
        continue;
      }

      // Place order at mid price (between best bid and ask) instead of ask+2c
      const midPrice = bestBid ? Math.round(((bestBid + yesPrice) / 2) * 100) : Math.round(yesPrice * 100);
      const limitPrice = Math.min(midPrice, 80); // hard cap at 80c
      try {
        const order = await getKalshiClient().callApi('CreateOrder', {
          ticker, action: 'buy', side: 'yes', type: 'limit',
          count: MOMENTUM_CONTRACTS, yes_price: limitPrice,
        });
        const filled = order?.order?.fill_count ?? 0;
        console.log(`${C.buy}[momentum]    BOUGHT ${filled}/${MOMENTUM_CONTRACTS} YES @ ${limitPrice}c${C.reset}`);
        // Always mark game as bought to prevent buying the other side,
        // even if fill_count is 0 (limit orders can fill moments later)
        boughtGames.add(gs);
        liveTickerSet.add(ticker);
        heldGames.add(gs);
        gameSessionCount.set(gs, (gameSessionCount.get(gs) || 0) + 1);
        if (filled > 0) {
          recordTrade(ticker, 'yes', limitPrice / 100, limitPrice / 100, filled);
          momentumPositions.set(ticker, {
            entryPrice: limitPrice / 100,
            highestSeen: limitPrice / 100,
            entryTime: nowMs,
          });
        }
      } catch (e) {
        console.error(`[momentum]    Order failed: ${e.message}`);
      }
      await sleep(1500);
    }

    if (signals === 0) {
      console.log(`[momentum] No signals this cycle`);
    }
  } catch (e) {
    console.warn(`[momentum] Scanner error: ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
