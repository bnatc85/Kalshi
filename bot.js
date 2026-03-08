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

// Entry signals — in-game sports
const MOMENTUM_MIN_MOVE = 0.05;        // 5c momentum move required
const MOMENTUM_WINDOW_MS = 5 * 60 * 1000; // momentum: within 5 minutes
const MOMENTUM_MIN_PRICE = 0.25;       // momentum: don't buy below 25c
const MOMENTUM_MAX_PRICE = 0.80;       // momentum: don't buy above 80c
const REVERSION_DIP = 0.03;            // mean reversion: 3c dip from avg
const REVERSION_AVG_WINDOW_MS = 30 * 60 * 1000; // mean reversion: 30min avg
const REVERSION_MIN_PRICE = 0.25;      // mean reversion: dip buyers from 25c+
const REVERSION_MAX_PRICE = 0.90;      // mean reversion: cap at 90c

// Exit thresholds — in-game sports
const MOMENTUM_STOP_LOSS = 0.10;       // sell if price drops 10c below entry
const MOMENTUM_TRAILING_STOP = 0.07;   // sell if price drops 7c from peak
const MOMENTUM_TAKE_PROFIT = 0.20;     // sell if price rises 20c above entry

// Tournament settings (golf, etc.) — DISABLED: momentum doesn't fit multi-day events
const TOURNEY_SERIES = []; // was: ['KXPGATOUR', 'KXPGAH2H', ...]
const TOURNEY_MIN_MOVE = 0.12;         // 12c move (significant leaderboard shift)
const TOURNEY_WINDOW_MS = 30 * 60 * 1000; // 30 min window
const TOURNEY_MIN_PRICE = 0.08;        // contenders start low
const TOURNEY_MAX_PRICE = 0.35;        // don't buy above 35c (too much downside)
const TOURNEY_STOP_LOSS = 0.15;        // wider stop (multi-day event)
const TOURNEY_TRAILING_STOP = 0.08;    // wider trailing stop
const TOURNEY_TAKE_PROFIT = 0.20;      // let winners run
const TOURNEY_MIN_VOLUME = 150;        // higher vol required for tournaments
const TOURNEY_REVERSION_DIP = 0.12;    // 12c dip for mean reversion
const TOURNEY_REVERSION_MIN = 0.10;    // reversion: min avg price
const TOURNEY_REVERSION_MAX = 0.50;    // reversion: max avg price
const TOURNEY_MAX_PER_PLAYER = 1;      // max 1 market type per player

// Contrarian/Fade strategy — buy No when Yes spikes too high
const FADE_MIN_SPIKE = 0.03;           // 3c+ spike triggers fade
const FADE_WINDOW_MS = 5 * 60 * 1000;  // spike within 5 minutes
const FADE_MIN_YES = 0.60;            // only fade when Yes >= 60c (No <= 40c)
const FADE_MAX_YES = 0.90;            // don't fade above 90c (too certain)

// Sports game series — fetched explicitly so they aren't crowded out by weather/politics
const SPORTS_SERIES = ['KXNBAGAME', 'KXMLBSTGAME', 'KXWBCGAME', 'KXWBCTOTAL', 'KXWBCSPREAD', 'KXWBCF5', 'KXNHLGAME', 'KXNFLGAME', 'KXMLSGAME'];

// Settlement sniping — buy near-certain outcomes for guaranteed small profit
const SNIPE_MIN_BID = 0.95;           // min bid price to consider sniping
const SNIPE_MAX_CONTRACTS = 10;       // max contracts per snipe
const SNIPE_SERIES = ['KXMLBSTGAME', 'KXWBCGAME', 'KXWBCTOTAL', 'KXWBCSPREAD', 'KXWBCF5', 'KXNBAGAME'];

// Orderbook imbalance — signal based on bid depth ratio
const OB_IMBALANCE_RATIO = 5;         // 5:1 ratio = strong signal

// Volume spike detection — sudden volume increase signals informed trading
const VOLUME_SPIKE_RATIO = 3;          // 3x recent volume delta = spike
const VOLUME_SPIKE_MIN_VOLUME = 50;    // min absolute volume delta for spike

// Entertainment markets (Netflix etc.)
const ENTERTAINMENT_SERIES = []; // was: ['KXNETFLIXRANKSHOWGLOBAL', ...] — disabled: multi-day markets don't fit momentum

// Cross-market arbitrage — detect pricing inconsistencies across correlated markets
const ARB_SERIES = ['KXWBCGAME', 'KXWBCTOTAL', 'KXWBCSPREAD', 'KXWBCF5', 'KXMLBSTGAME', 'KXNBAGAME'];
const ARB_MIN_DIVERGENCE = 0.15; // 15c+ divergence between correlated markets
const ARB_MAX_CONTRACTS = 3;     // conservative sizing for arb trades

// Win probability — minimum divergence between model and market price to trade
const WIN_PROB_MIN_EDGE = 0.10;        // 10c+ edge required (model vs market)
const WIN_PROB_STRONG_EDGE = 0.20;     // 20c+ = strong signal, allow bigger size

// Live scores — ESPN API for score validation
const SCORE_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const SCORE_SPORTS = [
  { key: 'baseball/mlb', prefix: 'KXM' },
  { key: 'basketball/nba', prefix: 'KXNBA' },
  { key: 'football/nfl', prefix: 'KXNFL' },
  { key: 'soccer/eng.1', prefix: 'KX' },
  { key: 'soccer/usa.1', prefix: 'KX' },
];

// Universal stop-loss for auto-sell (all positions, not just sports)
const AUTOSELL_STOP_LOSS = 0.20;       // sell at a loss if down 20c+ from entry

// Filters
// Volume-based position sizing: [minVolume, contracts]
const MOMENTUM_SIZE_TIERS = [
  [1000, 5],   // vol >= 1000 → 5 contracts
  [100,  3],   // vol >= 100  → 3 contracts
  [20,   1],   // vol >= 20   → 1 contract
];
const MOMENTUM_MAX_HOURS = 48;         // markets closing within 48h
const MOMENTUM_MIN_BID_DEPTH = 2;      // min bid-side contracts for liquidity
const MOMENTUM_MIN_VOLUME = 10;        // min contracts traded on ticker before entering
const MOMENTUM_MAX_PER_GAME = 1;       // max 1 ticker per game (don't buy both sides)
const MOMENTUM_SKIP_PREFIXES = ['KXMVE', 'KXNCAABB', 'KXNBAMENTION', 'KXNFLMENTION', 'KXMLBMENTION', 'KXNHLMENTION']; // skip parlays, NCAA, and mention markets

export async function startBot() {
  console.log('\n================================================');
  console.log('  Signal BonBon — Sports Momentum Trader v2.0');
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

  // Polymarket divergence scan disabled — focusing on sports momentum
  const snapshots = [];
  const signals = [];

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

  // Cancel stale unfilled buy orders from previous cycles
  try {
    const rawOrders = await getKalshiClient().callApi('GetOrders', { status: 'resting' });
    const orders = rawOrders?.orders || [];
    const cycleMs = config.pollIntervalSeconds * 2 * 1000; // cancel if older than 2 cycles
    let cancelled = 0;
    for (const o of orders) {
      if (o.action === 'buy') {
        const createdAt = new Date(o.created_time).getTime();
        const age = Date.now() - createdAt;
        if (age > cycleMs) {
          try {
            await getKalshiClient().callApi('CancelOrder', { order_id: o.order_id });
            openOrderTickers.delete(o.ticker);
            cancelled++;
          } catch (e) {
            console.warn(`[stale-order] Cancel failed ${o.order_id}: ${e.message}`);
          }
          await sleep(200);
        }
      }
    }
    if (cancelled > 0) console.log(`[stale-order] Cancelled ${cancelled} unfilled buy orders`);
  } catch (e) {
    console.warn(`[stale-order] Could not process stale orders: ${e.message}`);
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

    // Pre-fetch all orderbooks in parallel for positions we need to check
    const positionsToCheck = livePositions.filter(p => p.size !== 0 && !openSellTickers.has(p.marketId));
    const autosellOrderbooks = new Map();
    const OB_BATCH = 10;
    for (let i = 0; i < positionsToCheck.length; i += OB_BATCH) {
      const batch = positionsToCheck.slice(i, i + OB_BATCH);
      const results = await Promise.allSettled(
        batch.map(p =>
          fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${p.marketId}/orderbook`)
            .then(r => r.ok ? r.json() : null)
            .then(data => ({ ticker: p.marketId, ob: data ? (data.orderbook || data) : null }))
            .catch(() => ({ ticker: p.marketId, ob: null }))
        )
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.ob) {
          autosellOrderbooks.set(r.value.ticker, r.value.ob);
        }
      }
      if (i + OB_BATCH < positionsToCheck.length) await sleep(300);
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

      // Fetch order book — use pre-fetched data if available, otherwise fetch individually
      let bestBid = null;
      const obCached = autosellOrderbooks.get(ticker);
      if (obCached) {
        const yesBids = obCached.yes || [];
        const noBids = obCached.no || [];
        if (side === 'yes' && yesBids.length) {
          bestBid = yesBids[yesBids.length - 1][0] / 100;
        } else if (side === 'no' && noBids.length) {
          bestBid = noBids[noBids.length - 1][0] / 100;
        }
      }

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
        await sleep(200);
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

      // One-line status for each position
      const bidStr = bestBid != null ? `${(bestBid*100).toFixed(0)}c` : 'none';
      const entryStr = entry != null ? `${(entry*100).toFixed(1)}c` : '?';
      const gap = bestBid != null && entry != null ? ((bestBid - minSellPrice) * 100).toFixed(0) : '?';
      const gapSign = bestBid != null && bestBid >= minSellPrice ? '+' : '';
      console.log(
        `[auto-sell] ${ticker} ${side.toUpperCase()} ${posSize}x | entry=${entryStr} bid=${bidStr} min=${(minSellPrice*100).toFixed(0)}c (${gapSign}${gap}c)`
      );

      if (bestBid == null) continue;

      // Decide whether to sell
      // Skip stop-loss for game markets — let them ride to settlement
      const isGameTicker = /^KX(NBA|NHL|MLB|MLS|WBC|NFL)/.test(ticker);
      let sellReason = null;
      if (bestBid >= 0.95) {
        sellReason = `bid ${(bestBid*100).toFixed(0)}c >= 95c (near-certain)`;
      } else if (bestBid >= minSellPrice) {
        sellReason = `bid ${(bestBid*100).toFixed(0)}c >= min ${(minSellPrice*100).toFixed(0)}c`;
      } else if (!isGameTicker && entry != null && entry - bestBid >= AUTOSELL_STOP_LOSS) {
        sellReason = `${C.loss}STOP-LOSS: down ${((entry - bestBid)*100).toFixed(0)}c (entry ${(entry*100).toFixed(0)}c, bid ${(bestBid*100).toFixed(0)}c)${C.sell}`;
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
      await sleep(300);
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

  // 4c. Settlement sniping scanner
  await scanSettlementSnipes(liveTickerSet);

  // 4d. Cross-market arbitrage scanner
  await scanCrossMarketArb(liveTickerSet);

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
    await sleep(200);
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

    // Fetch sports game markets by series — the generic 200-market fetch gets
    // crowded out by weather/politics, so sports games never appear otherwise.
    // Only include today's games (ticker contains date like 26MAR08).
    const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayTag = String(nowET.getFullYear()).slice(-2) + MONTHS[nowET.getMonth()] + String(nowET.getDate()).padStart(2, '0');
    for (const series of SPORTS_SERIES) {
      try {
        const sResp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&series_ticker=${series}&status=open`);
        if (sResp.ok) {
          const sData = await sResp.json();
          for (const m of (sData.markets || [])) {
            if (m.ticker && m.ticker.includes(todayTag) && !markets.some(ex => ex.ticker === m.ticker)) {
              markets.push(m);
            }
          }
        }
      } catch {}
      await sleep(200);
    }

    // Also fetch tournament + entertainment markets — no close time filter
    const tourneyTickers = new Set();
    const allSeries = [...TOURNEY_SERIES, ...ENTERTAINMENT_SERIES];
    for (const series of allSeries) {
      try {
        const tResp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&series_ticker=${series}&status=open`);
        if (tResp.ok) {
          const tData = await tResp.json();
          for (const m of (tData.markets || [])) {
            if (m.ticker && !markets.some(ex => ex.ticker === m.ticker)) {
              markets.push(m);
              tourneyTickers.add(m.ticker);
            }
          }
        }
      } catch {}
      await sleep(200);
    }

    if (!markets.length) { console.log(`[momentum] No markets found`); return; }

    // Build a price lookup from the fetched markets for exit checks
    const currentPrices = new Map();
    for (const m of markets) {
      if (!m.ticker) continue;
      const p = (m.yes_ask > 1 ? m.yes_ask : (m.last_price || 0)) / 100;
      if (p > 0) currentPrices.set(m.ticker, p);
    }

    // For live game markets, fetch orderbook to get real-time mid-prices
    // The bulk /markets endpoint returns stale yes_ask/last_price
    const gameMarketTickers = markets
      .filter(m => m.ticker && /^KX(NBA|NHL|MLB|MLS|WBC|NFL)/.test(m.ticker))
      .filter(m => {
        const p = currentPrices.get(m.ticker) || 0;
        return p >= 0.20 && p <= 0.85;
      });
    // Fetch orderbooks in parallel batches of 10 to stay fast without hammering API
    let obFetched = 0;
    const BATCH_SIZE = 10;
    for (let i = 0; i < gameMarketTickers.length; i += BATCH_SIZE) {
      const batch = gameMarketTickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(m =>
          fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${m.ticker}/orderbook`)
            .then(r => r.ok ? r.json() : null)
            .then(data => ({ ticker: m.ticker, data }))
            .catch(() => ({ ticker: m.ticker, data: null }))
        )
      );
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value.data) continue;
        const ob = r.value.data.orderbook || r.value.data;
        const yesBids = ob.yes || [];
        const noAsks = ob.no || [];
        const bestYesBid = yesBids.length ? yesBids[yesBids.length - 1][0] / 100 : null;
        const bestNoBid = noAsks.length ? noAsks[noAsks.length - 1][0] / 100 : null;
        const bestYesAsk = bestNoBid != null ? 1 - bestNoBid : null;
        let mid = null;
        if (bestYesBid != null && bestYesAsk != null) {
          mid = (bestYesBid + bestYesAsk) / 2;
        } else if (bestYesBid != null) {
          mid = bestYesBid;
        }
        if (mid != null && mid > 0) {
          currentPrices.set(r.value.ticker, mid);
          obFetched++;
        }
      }
      if (i + BATCH_SIZE < gameMarketTickers.length) await sleep(200);
    }
    if (obFetched > 0) console.log(`[momentum] Updated ${obFetched}/${gameMarketTickers.length} game market prices from orderbook`);

    // --- Step 1: Check exits for active momentum positions ---
    let exits = 0;
    for (const [ticker, mp] of momentumPositions) {
      const yesNow = currentPrices.get(ticker);
      if (yesNow == null) continue;

      // For No positions, track the No price (inverse of Yes)
      const posSide = mp.side || 'yes';
      const curPrice = posSide === 'no' ? (1 - yesNow) : yesNow;

      // Update highest seen price (for trailing stop)
      if (curPrice > mp.highestSeen) mp.highestSeen = curPrice;

      const stopLoss = mp.isTourney ? TOURNEY_STOP_LOSS : MOMENTUM_STOP_LOSS;
      const trailingStop = mp.isTourney ? TOURNEY_TRAILING_STOP : MOMENTUM_TRAILING_STOP;
      const takeProfit = mp.isTourney ? TOURNEY_TAKE_PROFIT : MOMENTUM_TAKE_PROFIT;

      // For game markets: only exit on take-profit (90c+), let the rest ride to settlement
      const isGameTkr = /^KX(NBA|NHL|MLB|MLS|WBC|NFL)/.test(ticker);
      let exitReason = null;
      if (!isGameTkr && curPrice <= mp.entryPrice - stopLoss) {
        exitReason = `STOP-LOSS (${(curPrice*100).toFixed(0)}c, entry ${(mp.entryPrice*100).toFixed(0)}c)`;
      } else if (!isGameTkr && curPrice <= mp.highestSeen - trailingStop) {
        exitReason = `TRAILING-STOP (${(curPrice*100).toFixed(0)}c, peak ${(mp.highestSeen*100).toFixed(0)}c)`;
      } else if (curPrice >= 0.90) {
        exitReason = `TAKE-PROFIT (${(curPrice*100).toFixed(0)}c, entry ${(mp.entryPrice*100).toFixed(0)}c)`;
      }

      if (!exitReason) continue;
      // Add score context to exit log
      let exitScore = '';
      if (!mp.isTourney) {
        const sc = await getScoreContext(ticker);
        if (sc) exitScore = ` | ${sc.display}`;
      }
      console.log(`[momentum] EXIT ${ticker} ${posSide.toUpperCase()}: ${exitReason}${exitScore}`);

      if (config.dryRun) {
        console.log(`[momentum]    DRY RUN: would sell`);
        momentumPositions.delete(ticker);
        continue;
      }

      // Sell at current price (limit at curPrice - 1c to ensure fill)
      const sellPriceCents = Math.max(1, Math.round((curPrice - 0.01) * 100));
      const sellCount = mp.contracts || 1;
      try {
        await getKalshiClient().callApi('CreateOrder', {
          ticker, action: 'sell', side: posSide, type: 'limit',
          count: sellCount,
          ...(posSide === 'no'
            ? { no_price: sellPriceCents }
            : { yes_price: sellPriceCents }),
        });
        const pnl = (curPrice - mp.entryPrice - 0.01) * sellCount;
        const pnlColor = pnl >= 0 ? C.win : C.loss;
        console.log(`${C.sell}[momentum]    SOLD ${posSide.toUpperCase()} @ ${sellPriceCents}c | ${pnlColor}PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}${C.reset}`);
        closeTrade(ticker, curPrice, pnl);
        exits++;
      } catch (e) {
        console.error(`[momentum]    Sell failed: ${e.message}`);
      }
      momentumPositions.delete(ticker);
      await sleep(300);
    }

    // --- Step 2: Scan for new signals ---
    // Count markets with prices in tradeable range for debug
    let inRange = 0;
    const seenSeries = new Set();
    for (const m of markets) {
      if (!m.ticker) continue;
      const p = currentPrices.get(m.ticker);
      if (p && p >= 0.20 && p <= 0.85) inRange++;
      // Track unique series prefixes
      const prefix = m.ticker.match(/^[A-Z]+/)?.[0];
      if (prefix) seenSeries.add(prefix);
    }
    console.log(`[momentum] Scanning ${markets.length} markets (${inRange} in price range, ${momentumPositions.size} active, ${exits} exited) | series: ${[...seenSeries].join(', ')}`);

    let signals = 0;
    const nowMs = Date.now();

    // Game session ID: extract date+time+teams portion to catch cross-market-type
    // correlation (e.g., KXWBCTOTAL and KXWBCSPREAD for the same game).
    // Matches patterns like 26MAR061900NICDOM from the ticker.
    // For tournaments: extract player abbreviation (e.g., TFLE from KXPGATOP20-ARPIPBM26-TFLE)
    // so multiple market types for the same player get grouped.
    const gameSession = (t) => {
      // Game market tickers: KXMLSGAME-26MAR08CINTOR-TOR, KXNBAGAME-26MAR081930BOSCLE-BOS
      // Group by everything except the last segment (team/outcome suffix)
      if (/^KX(NBA|NHL|MLB|MLS|WBC|NFL)/.test(t)) {
        const lastDash = t.lastIndexOf('-');
        return lastDash > 0 ? t.substring(0, lastDash) : t;
      }
      // Sports game tickers (non-game-market): 26MAR061900NICDOM
      const sports = t.match(/(\d{2}[A-Z]{3}\d{4,6}[A-Z]{2,})/);
      if (sports) return sports[1];
      // Tournament tickers: last segment after dash is the player (e.g., -TFLE)
      const parts = t.split('-');
      if (parts.length >= 3) {
        const player = parts[parts.length - 1];
        const event = parts[1]?.match(/^[A-Z]+\d+/)?.[0] || parts[1];
        return `${event}-${player}`;
      }
      return t;
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

      const isTourney = tourneyTickers.has(ticker);
      const yesPrice = currentPrices.get(ticker);
      if (!yesPrice || yesPrice < 0.05) continue;

      // Pick parameters based on market type
      const pMinMove = isTourney ? TOURNEY_MIN_MOVE : MOMENTUM_MIN_MOVE;
      const pWindow = isTourney ? TOURNEY_WINDOW_MS : MOMENTUM_WINDOW_MS;
      const pMinPrice = isTourney ? TOURNEY_MIN_PRICE : MOMENTUM_MIN_PRICE;
      const pMaxPrice = isTourney ? TOURNEY_MAX_PRICE : MOMENTUM_MAX_PRICE;
      const pRevDip = isTourney ? TOURNEY_REVERSION_DIP : REVERSION_DIP;
      const pRevMin = isTourney ? TOURNEY_REVERSION_MIN : REVERSION_MIN_PRICE;
      const pRevMax = isTourney ? TOURNEY_REVERSION_MAX : REVERSION_MAX_PRICE;
      const pMinVol = isTourney ? TOURNEY_MIN_VOLUME : MOMENTUM_MIN_VOLUME;

      // Update price history (keep 2x the longer window for mean reversion)
      const historyWindow = isTourney ? TOURNEY_WINDOW_MS * 2 : REVERSION_AVG_WINDOW_MS * 2;
      if (!priceHistory.has(ticker)) priceHistory.set(ticker, []);
      const history = priceHistory.get(ticker);
      history.push({ price: yesPrice, time: nowMs, volume: m.volume || 0 });
      while (history.length > 0 && history[0].time < nowMs - historyWindow) {
        history.shift();
      }

      // Debug: log NBA/NHL game markets to see why they don't generate signals
      const isGameMarket = /^KX(NBA|NHL|MLB|MLS|WBC|NFL)/.test(ticker);

      // Need 4+ data points for momentum/reversion, but WIN-PROB works with just 1
      if (history.length < 4 && !isGameMarket) continue;

      // --- Signal detection ---
      let signalType = null;
      let signalDetail = '';
      let tradeSide = 'yes'; // default: buy Yes
      const tag = isTourney ? 'TOURNEY' : 'MOMENTUM';

      // A-0) Win probability model — highest priority signal
      // Compares ESPN/model win probability to Kalshi market price
      if (!signalType && isGameMarket && scoreCtx && scoreCtx.isLive) {
        const wp = await getWinProbForTicker(ticker, scoreCtx);
        if (wp && wp.winProb != null) {
          const marketPrice = yesPrice; // Kalshi Yes price = implied win prob
          const edge = wp.winProb - marketPrice; // positive = market underpricing this team
          if (edge >= WIN_PROB_MIN_EDGE && marketPrice <= 0.45) {
            // Market is underpricing — buy Yes (underdog with edge)
            signalType = 'WIN-PROB';
            tradeSide = 'yes';
            signalDetail = `${wp.source}: ${(wp.winProb*100).toFixed(0)}% vs market ${(marketPrice*100).toFixed(0)}c (edge +${(edge*100).toFixed(0)}c)`;
          } else if (-edge >= WIN_PROB_MIN_EDGE && marketPrice >= 0.55) {
            // Market is overpricing — buy No (market thinks Yes is too high)
            signalType = 'WIN-PROB';
            tradeSide = 'no';
            const noPrice = 1 - marketPrice;
            signalDetail = `${wp.source}: ${(wp.winProb*100).toFixed(0)}% vs market ${(marketPrice*100).toFixed(0)}c (edge +${((-edge)*100).toFixed(0)}c on No @ ${(noPrice*100).toFixed(0)}c)`;
          }
        }
      }

      // A) Momentum breakout (buy Yes on rising price)
      const momentumStart = nowMs - pWindow;
      const oldEntry = history.find(h => h.time >= momentumStart) || history[0];
      const priceMove = yesPrice - oldEntry.price;

      if (priceMove >= pMinMove && yesPrice >= pMinPrice && yesPrice <= pMaxPrice) {
        signalType = tag;
        signalDetail = `${(oldEntry.price*100).toFixed(0)}c->${(yesPrice*100).toFixed(0)}c (+${(priceMove*100).toFixed(0)}c/${Math.round((nowMs-oldEntry.time)/1000)}s)`;
      }

      // B) Contrarian/Fade: buy No when Yes spikes too high (better risk/reward)
      if (!signalType && !isTourney) {
        const fadeStart = nowMs - FADE_WINDOW_MS;
        const fadeOld = history.find(h => h.time >= fadeStart) || history[0];
        const fadeSpike = yesPrice - fadeOld.price;
        if (fadeSpike >= FADE_MIN_SPIKE && yesPrice >= FADE_MIN_YES && yesPrice <= FADE_MAX_YES) {
          signalType = 'FADE';
          tradeSide = 'no';
          const noPrice = ((1 - yesPrice) * 100).toFixed(0);
          signalDetail = `Yes spiked ${(fadeOld.price*100).toFixed(0)}c->${(yesPrice*100).toFixed(0)}c, buying No @ ~${noPrice}c`;
        }
      }

      // C) Mean reversion dip (buy Yes on dip below average)
      if (!signalType) {
        const avgWindow = history.filter(h => h.time >= nowMs - (isTourney ? TOURNEY_WINDOW_MS : REVERSION_AVG_WINDOW_MS));
        if (avgWindow.length >= 3) {
          const avg = avgWindow.reduce((s, h) => s + h.price, 0) / avgWindow.length;
          const dip = avg - yesPrice;
          if (dip >= pRevDip && avg >= pRevMin && avg <= pRevMax) {
            signalType = isTourney ? 'T-REVERSION' : 'REVERSION';
            signalDetail = `avg ${(avg*100).toFixed(0)}c, now ${(yesPrice*100).toFixed(0)}c (dip ${(dip*100).toFixed(0)}c)`;
          }
        }
      }

      // Debug: log signal detection results for game markets
      if (isGameMarket && yesPrice >= pMinPrice && yesPrice <= pMaxPrice) {
        const move = (priceMove * 100).toFixed(1);
        console.log(`[momentum-dbg] ${ticker} yes=${(yesPrice*100).toFixed(0)}c move=${move}c/${history.length}pts signal=${signalType || 'none'} vol=${m.volume || 0}`);
      }

      // --- Filters (before orderbook fetch to save API calls) ---
      // Skip if we already hold this ticker or hit the per-game/player cap
      const gs = gameSession(ticker);
      if (liveTickerSet.has(ticker) || boughtGames.has(gs)) continue;
      const gsCount = gameSessionCount.get(gs) || 0;
      const maxPerSession = isTourney ? TOURNEY_MAX_PER_PLAYER : MOMENTUM_MAX_PER_GAME;
      if (gsCount >= maxPerSession) continue;

      // Time-to-close filter (skip for tournaments and game markets — their
      // close_time is often set days/weeks out, not at game end)
      if (!isTourney && !isGameMarket) {
        const closeTime = m.close_time ? new Date(m.close_time).getTime() : 0;
        const hoursToClose = closeTime ? (closeTime - nowMs) / (1000 * 60 * 60) : 999;
        if (hoursToClose > 12) continue;
      }

      // Live game filter: only trade when the game is actually in progress
      // Prevents buying on pre-game price noise
      let scoreCtx = null;
      if (!isTourney) {
        scoreCtx = await getScoreContext(ticker);
        if (scoreCtx && !scoreCtx.isLive) {
          if (signalType || isGameMarket) {
            console.log(`[momentum-dbg] SKIP ${ticker}: game not live (${scoreCtx.status}) — ${signalType || 'no signal'}`);
          }
          continue;
        }
        if (isGameMarket && !scoreCtx) {
          console.log(`[momentum-dbg] ${ticker}: no ESPN match (null scoreCtx) — letting through`);
        }

        // Score-aware: skip blowouts (game is decided, bad risk/reward)
        if (scoreCtx && scoreCtx.isLive && scoreCtx.scores && scoreCtx.scores.length >= 2) {
          const scoreDiff = Math.abs(scoreCtx.scores[0] - scoreCtx.scores[1]);
          const sport = ticker.match(/^KX(NBA|NHL|MLB|MLS|WBC|NFL)/)?.[1];
          const blowoutThreshold = sport === 'NBA' ? 25 : sport === 'NFL' ? 21 : sport === 'NHL' ? 4 : 5;
          if (scoreDiff >= blowoutThreshold) {
            if (signalType) console.log(`[momentum-dbg] SKIP ${ticker}: blowout (${scoreCtx.display}, diff=${scoreDiff})`);
            continue;
          }
        }
      }

      // Skip if no signal yet AND this market wouldn't qualify for OB imbalance
      // (OB imbalance only applies to non-tourney in-game markets within price range)
      if (!signalType && (isTourney || yesPrice < 0.20 || yesPrice > pMaxPrice)) continue;

      // Liquidity check: fetch orderbook, require min bid depth
      let bestBid = null;
      let bidDepth = 0;
      let yesBidDepth = 0, noBidDepth = 0;
      let obYesBids = [], obNoBids = [];
      try {
        const obResp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`);
        if (obResp.ok) {
          const obData = await obResp.json();
          const ob = obData.orderbook || obData;
          obYesBids = ob.yes || [];
          obNoBids = ob.no || [];
          yesBidDepth = obYesBids.reduce((s, lvl) => s + lvl[1], 0);
          noBidDepth = obNoBids.reduce((s, lvl) => s + lvl[1], 0);
        }
      } catch {}
      await sleep(200);

      // D) Orderbook imbalance signal — strong directional bias from depth
      if (!signalType && !isTourney && yesBidDepth > 0 && noBidDepth > 0) {
        const yesNoRatio = yesBidDepth / noBidDepth;
        const noYesRatio = noBidDepth / yesBidDepth;
        if (yesNoRatio >= OB_IMBALANCE_RATIO && yesPrice >= pMinPrice && yesPrice <= 0.45) {
          signalType = 'OB-IMBAL';
          tradeSide = 'yes';
          signalDetail = `Yes depth ${yesBidDepth} vs No ${noBidDepth} (${yesNoRatio.toFixed(1)}:1)`;
        } else if (noYesRatio >= OB_IMBALANCE_RATIO && yesPrice >= 0.55 && yesPrice <= 0.80) {
          // No entry price = 1 - yesPrice, so yesPrice 0.55-0.80 = No at 20-45c (underdog)
          signalType = 'OB-IMBAL';
          tradeSide = 'no';
          signalDetail = `No depth ${noBidDepth} vs Yes ${yesBidDepth} (${noYesRatio.toFixed(1)}:1)`;
        }
      }

      // E) Volume spike detection — sudden volume increase signals informed trading
      if (!signalType && !isTourney && history.length >= 4) {
        const curVol = m.volume || 0;
        const prevVol = history[history.length - 2]?.volume || 0;
        const recentDelta = curVol - prevVol;
        const olderDeltas = [];
        for (let k = 1; k < history.length - 1; k++) {
          olderDeltas.push((history[k].volume || 0) - (history[k-1].volume || 0));
        }
        const avgDelta = olderDeltas.length > 0 ? olderDeltas.reduce((s,d) => s+d, 0) / olderDeltas.length : 0;
        if (avgDelta > 0 && recentDelta >= avgDelta * VOLUME_SPIKE_RATIO && recentDelta >= VOLUME_SPIKE_MIN_VOLUME) {
          const recentPrice = history[history.length - 1].price;
          const olderPrice = history[Math.max(0, history.length - 4)].price;
          if (recentPrice > olderPrice && yesPrice >= pMinPrice && yesPrice <= 0.45) {
            signalType = 'VOL-SPIKE';
            tradeSide = 'yes';
            signalDetail = `vol delta ${recentDelta} vs avg ${avgDelta.toFixed(0)} (${(recentDelta/avgDelta).toFixed(1)}x), price rising`;
          } else if (recentPrice < olderPrice && (1 - yesPrice) >= 0.20 && (1 - yesPrice) <= 0.45) {
            signalType = 'VOL-SPIKE';
            tradeSide = 'no';
            signalDetail = `vol delta ${recentDelta} vs avg ${avgDelta.toFixed(0)} (${(recentDelta/avgDelta).toFixed(1)}x), price falling`;
          }
        }
      }

      if (!signalType) continue;

      // Favor underdogs: skip momentum/reversion entries where our side costs > 40c
      // WIN-PROB has its own price checks, so skip this filter for it
      const entryPriceForSide = tradeSide === 'no' ? (1 - yesPrice) : yesPrice;
      if ((signalType === 'MOMENTUM' || signalType === 'REVERSION') && entryPriceForSide > 0.40) {
        continue;
      }

      // Late-game bias: skip early-game signals (except OB-IMBAL and WIN-PROB)
      if (scoreCtx && scoreCtx.isLive && scoreCtx.period === 1 && signalType !== 'OB-IMBAL' && signalType !== 'WIN-PROB') {
        continue;
      }

      // Set bestBid and bidDepth for the chosen trade side
      if (tradeSide === 'no') {
        bidDepth = noBidDepth;
        if (obNoBids.length) bestBid = obNoBids[obNoBids.length - 1][0] / 100;
      } else {
        bidDepth = yesBidDepth;
        if (obYesBids.length) bestBid = obYesBids[obYesBids.length - 1][0] / 100;
      }

      if (bidDepth < MOMENTUM_MIN_BID_DEPTH) continue;

      // Volume check
      const volume = m.volume || 0;
      if (volume < pMinVol) continue;

      // Volume-based position sizing — WIN-PROB gets double size (higher conviction)
      let contractCount = (MOMENTUM_SIZE_TIERS.find(([minVol]) => volume >= minVol) || [0, 1])[1];
      if (signalType === 'WIN-PROB') contractCount = Math.min(contractCount * 2, 10);

      signals++;
      const title = (m.title || m.subtitle || ticker).substring(0, 50);
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : 0;
      const hoursToClose = closeTime ? (closeTime - nowMs) / (1000 * 60 * 60) : 999;
      const closesIn = hoursToClose < 1 ? `${Math.round(hoursToClose*60)}min` : hoursToClose < 48 ? `${hoursToClose.toFixed(1)}h` : `${Math.round(hoursToClose/24)}d`;

      // Fetch live score context (non-blocking — cache avoids repeated calls)
      let scoreStr = '';
      if (!isTourney) {
        const scoreCtx = await getScoreContext(ticker);
        if (scoreCtx) scoreStr = ` | SCORE: ${scoreCtx.display}`;
      }

      console.log(
        `[momentum] >> ${signalType}: ${title} | ${ticker} | ${tradeSide.toUpperCase()}\n` +
        `[momentum]    ${signalDetail} | bid=${bestBid ? (bestBid*100).toFixed(0)+'c' : '?'} depth=${bidDepth} vol=${volume} | closes ${closesIn} | size=${contractCount}${scoreStr}`
      );

      if (config.dryRun) {
        console.log(`[momentum]    DRY RUN: would buy ${contractCount} ${tradeSide.toUpperCase()} @ ${(tradeSide === 'no' ? (1 - yesPrice) : yesPrice)*100|0}c`);
        continue;
      }

      // Place order — WIN-PROB crosses the spread (10c+ edge absorbs it),
      // other signals use mid-price to avoid spread cost
      let limitPrice;
      const crossSpread = signalType === 'WIN-PROB';
      if (tradeSide === 'no') {
        const noBestBid = obNoBids.length ? obNoBids[obNoBids.length - 1][0] : null;
        const bestYesBid = obYesBids.length ? obYesBids[obYesBids.length - 1][0] : null;
        const noAsk = bestYesBid != null ? 100 - bestYesBid : null;
        if (crossSpread) {
          limitPrice = noAsk || Math.round((1 - yesPrice) * 100);
        } else if (noBestBid != null && noAsk != null) {
          limitPrice = Math.round((noBestBid + noAsk) / 2);
        } else {
          limitPrice = noAsk || Math.round((1 - yesPrice) * 100);
        }
        limitPrice = Math.min(limitPrice, 45); // underdog cap
      } else {
        const yesBestBid = obYesBids.length ? obYesBids[obYesBids.length - 1][0] : null;
        const bestNoBid = obNoBids.length ? obNoBids[obNoBids.length - 1][0] : null;
        const yesAsk = bestNoBid != null ? 100 - bestNoBid : null;
        if (crossSpread) {
          limitPrice = yesAsk || Math.round(yesPrice * 100);
        } else if (yesBestBid != null && yesAsk != null) {
          limitPrice = Math.round((yesBestBid + yesAsk) / 2);
        } else {
          limitPrice = yesAsk || Math.round(yesPrice * 100);
        }
        limitPrice = Math.min(limitPrice, 45); // underdog cap
      }
      try {
        const orderParams = {
          ticker, action: 'buy', side: tradeSide, type: 'limit',
          count: contractCount,
          ...(tradeSide === 'no'
            ? { no_price: limitPrice }
            : { yes_price: limitPrice }),
        };
        const order = await getKalshiClient().callApi('CreateOrder', orderParams);
        const filled = order?.order?.fill_count ?? 0;
        console.log(`${C.buy}[momentum]    BOUGHT ${filled}/${contractCount} ${tradeSide.toUpperCase()} @ ${limitPrice}c${C.reset}`);
        // Always mark game as bought to prevent buying the other side,
        // even if fill_count is 0 (limit orders can fill moments later)
        boughtGames.add(gs);
        liveTickerSet.add(ticker);
        heldGames.add(gs);
        gameSessionCount.set(gs, (gameSessionCount.get(gs) || 0) + 1);
        if (filled > 0) {
          recordTrade(ticker, tradeSide, limitPrice / 100, limitPrice / 100, filled);
          momentumPositions.set(ticker, {
            entryPrice: limitPrice / 100,
            highestSeen: limitPrice / 100,
            entryTime: nowMs,
            contracts: filled,
            isTourney,
            side: tradeSide,
          });
        }
      } catch (e) {
        console.error(`[momentum]    Order failed: ${e.message}`);
      }
      await sleep(300);
    }

    if (signals === 0) {
      console.log(`[momentum] No signals this cycle`);
    }
  } catch (e) {
    console.warn(`[momentum] Scanner error: ${e.message}`);
  }
}

/**
 * Settlement sniping — buy near-certain outcomes (95c+) for small guaranteed profit.
 * These are markets where one side is nearly settled (e.g. team winning 10-0 in 8th inning).
 */
async function scanSettlementSnipes(liveTickerSet) {
  try {
    const now = Date.now();
    const minClose = Math.floor((now - 60 * 1000) / 1000);
    const maxClose = Math.floor((now + 6 * 60 * 60 * 1000) / 1000); // closing within 6h
    let snipeMarkets = [];

    for (const series of SNIPE_SERIES) {
      try {
        const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&series_ticker=${series}&status=open&min_close_ts=${minClose}&max_close_ts=${maxClose}`);
        if (resp.ok) {
          const data = await resp.json();
          snipeMarkets.push(...(data.markets || []));
        }
      } catch {}
      await sleep(200);
    }

    if (!snipeMarkets.length) return;

    let snipes = 0;
    for (const m of snipeMarkets) {
      const ticker = m.ticker;
      if (!ticker || liveTickerSet.has(ticker)) continue;

      // Check orderbook for 95c+ bids
      try {
        const obResp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`);
        if (!obResp.ok) continue;
        const obData = await obResp.json();
        const ob = obData.orderbook || obData;
        const yesBids = ob.yes || [];
        const noBids = ob.no || [];

        // Check Yes side: if best Yes bid >= 95c, buy Yes
        let snipeSide = null, snipePrice = null, snipeBid = null;
        if (yesBids.length) {
          const bestYes = yesBids[yesBids.length - 1][0] / 100;
          if (bestYes >= SNIPE_MIN_BID) {
            snipeSide = 'yes';
            snipePrice = Math.round(bestYes * 100); // buy at the bid
            snipeBid = bestYes;
          }
        }
        // Check No side: if best No bid >= 95c, buy No
        if (!snipeSide && noBids.length) {
          const bestNo = noBids[noBids.length - 1][0] / 100;
          if (bestNo >= SNIPE_MIN_BID) {
            snipeSide = 'no';
            snipePrice = Math.round(bestNo * 100);
            snipeBid = bestNo;
          }
        }

        if (!snipeSide) continue;

        const title = (m.title || m.subtitle || ticker).substring(0, 50);
        console.log(`[snipe] >> ${title} | ${ticker} | ${snipeSide.toUpperCase()} bid=${(snipeBid*100).toFixed(0)}c`);

        if (config.dryRun) {
          console.log(`[snipe]    DRY RUN: would buy ${SNIPE_MAX_CONTRACTS} ${snipeSide.toUpperCase()} @ ${snipePrice}c`);
          continue;
        }

        const order = await getKalshiClient().callApi('CreateOrder', {
          ticker, action: 'buy', side: snipeSide, type: 'limit',
          count: SNIPE_MAX_CONTRACTS,
          ...(snipeSide === 'no'
            ? { no_price: snipePrice }
            : { yes_price: snipePrice }),
        });
        const filled = order?.order?.fill_count ?? 0;
        console.log(`${C.buy}[snipe]    BOUGHT ${filled}/${SNIPE_MAX_CONTRACTS} ${snipeSide.toUpperCase()} @ ${snipePrice}c${C.reset}`);
        liveTickerSet.add(ticker);
        if (filled > 0) {
          recordTrade(ticker, snipeSide, snipePrice / 100, snipePrice / 100, filled);
          snipes++;
        }
        await sleep(300);
      } catch (e) {
        console.warn(`[snipe] ${ticker}: ${e.message}`);
      }
    }
    if (snipes > 0) console.log(`[snipe] Placed ${snipes} snipe trades`);
  } catch (e) {
    console.warn(`[snipe] Scanner error: ${e.message}`);
  }
}

/**
 * Cross-market arbitrage — find pricing inconsistencies across correlated markets.
 * Groups markets by game session (same date/time/teams) and compares implied probabilities.
 * E.g., if moneyline implies 70% but spread implies 50%, buy the cheap side.
 */
async function scanCrossMarketArb(liveTickerSet) {
  try {
    const now = Date.now();
    const minClose = Math.floor((now - 60 * 1000) / 1000);
    const maxClose = Math.floor((now + 6 * 60 * 60 * 1000) / 1000);

    // Fetch all arb-eligible markets
    const allMarkets = [];
    for (const series of ARB_SERIES) {
      try {
        const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&series_ticker=${series}&status=open&min_close_ts=${minClose}&max_close_ts=${maxClose}`);
        if (resp.ok) {
          const data = await resp.json();
          for (const m of (data.markets || [])) {
            if (m.ticker) allMarkets.push({ ...m, seriesTicker: series });
          }
        }
      } catch {}
      await sleep(200);
    }

    if (allMarkets.length < 2) return;

    // Extract game session from ticker
    const getGameSession = (t) => {
      const m = t.match(/(\d{2}[A-Z]{3}\d{4,6}[A-Z]{2,})/);
      return m ? m[1] : null;
    };

    // Group by game session
    const gameGroups = new Map();
    for (const m of allMarkets) {
      const gs = getGameSession(m.ticker);
      if (!gs) continue;
      if (!gameGroups.has(gs)) gameGroups.set(gs, []);
      gameGroups.get(gs).push(m);
    }

    let arbSignals = 0;
    for (const [gs, markets] of gameGroups) {
      if (markets.length < 2) continue;

      // Get Yes prices for each market type in this game
      const prices = markets.map(m => ({
        ticker: m.ticker,
        series: m.seriesTicker,
        title: (m.title || m.subtitle || m.ticker).substring(0, 40),
        yesPrice: (m.yes_ask > 1 ? m.yes_ask : (m.last_price || 0)) / 100,
        volume: m.volume || 0,
      })).filter(p => p.yesPrice > 0.05 && p.yesPrice < 0.95);

      if (prices.length < 2) continue;

      // Find the largest price divergence between any two markets in the same game
      for (let i = 0; i < prices.length; i++) {
        for (let j = i + 1; j < prices.length; j++) {
          const a = prices[i], b = prices[j];
          // Skip if same series (e.g. two KXWBCGAME markets)
          if (a.series === b.series) continue;

          const divergence = Math.abs(a.yesPrice - b.yesPrice);
          if (divergence < ARB_MIN_DIVERGENCE) continue;

          // Buy the cheaper one (lower Yes price = more upside)
          const cheap = a.yesPrice < b.yesPrice ? a : b;
          const expensive = a.yesPrice < b.yesPrice ? b : a;

          if (liveTickerSet.has(cheap.ticker)) continue;
          if (cheap.volume < 20) continue;

          console.log(
            `[arb] >> ${gs}: ${cheap.title} (${(cheap.yesPrice*100).toFixed(0)}c) vs ${expensive.title} (${(expensive.yesPrice*100).toFixed(0)}c) = ${(divergence*100).toFixed(0)}c divergence`
          );

          if (config.dryRun) {
            console.log(`[arb]    DRY RUN: would buy ${ARB_MAX_CONTRACTS} YES ${cheap.ticker} @ ${(cheap.yesPrice*100).toFixed(0)}c`);
            continue;
          }

          // Buy the cheap side
          const limitPrice = Math.round(cheap.yesPrice * 100);
          try {
            const order = await getKalshiClient().callApi('CreateOrder', {
              ticker: cheap.ticker, action: 'buy', side: 'yes', type: 'limit',
              count: ARB_MAX_CONTRACTS, yes_price: limitPrice,
            });
            const filled = order?.order?.fill_count ?? 0;
            console.log(`${C.buy}[arb]    BOUGHT ${filled}/${ARB_MAX_CONTRACTS} YES @ ${limitPrice}c${C.reset}`);
            liveTickerSet.add(cheap.ticker);
            if (filled > 0) {
              recordTrade(cheap.ticker, 'yes', limitPrice / 100, limitPrice / 100, filled);
            }
            arbSignals++;
          } catch (e) {
            console.error(`[arb]    Order failed: ${e.message}`);
          }
          await sleep(300);
        }
      }
    }
    if (arbSignals > 0) console.log(`[arb] Placed ${arbSignals} arb trades`);
  } catch (e) {
    console.warn(`[arb] Scanner error: ${e.message}`);
  }
}

/**
 * Fetch live scores from ESPN API.
 * Returns a Map of team abbreviation -> { score, status, period, timeLeft }
 */
const liveScoreCache = new Map(); // teamAbbr -> { score, status, period, fetchTime }

async function fetchLiveScores() {
  const now = Date.now();
  // Only refresh every 60s
  if (liveScoreCache.size > 0 && liveScoreCache.get('_lastFetch') > now - 60000) return liveScoreCache;

  for (const sport of SCORE_SPORTS) {
    try {
      const resp = await fetch(`${SCORE_API_BASE}/${sport.key}/scoreboard`);
      if (!resp.ok) continue;
      const data = await resp.json();

      for (const event of (data.events || [])) {
        const competition = event.competitions?.[0];
        if (!competition) continue;
        const eventId = event.id; // ESPN event ID for win probability lookup
        const status = competition.status?.type?.name || 'unknown'; // STATUS_IN_PROGRESS, STATUS_FINAL, etc.
        const period = competition.status?.period || 0;
        const clock = competition.status?.displayClock || '';

        for (const team of (competition.competitors || [])) {
          const abbr = team.team?.abbreviation;
          if (!abbr) continue;
          const isHome = team.homeAway === 'home';
          liveScoreCache.set(abbr, {
            score: parseInt(team.score || '0'),
            status,
            period,
            clock,
            sport: sport.key,
            eventId,
            isHome,
            fetchTime: now,
          });
        }
      }
    } catch {}
    await sleep(300);
  }
  liveScoreCache.set('_lastFetch', now);
  return liveScoreCache;
}

/**
 * Extract team abbreviations from a Kalshi ticker.
 * E.g., KXWBCGAME-26MAR061900NICDOM -> ['NIC', 'DOM'] (last 3+3 chars of team portion)
 * or KXMLBSTGAME-26APR071800NYYBAL -> ['NYY', 'BAL']
 */
function extractTeams(ticker) {
  const m = ticker.match(/\d{4,6}([A-Z]+)$/);
  if (!m) return [];
  const teams = m[1];
  // Teams are concatenated: 3-char abbreviations
  if (teams.length >= 6) {
    return [teams.substring(0, 3), teams.substring(3, 6)];
  }
  if (teams.length >= 4) {
    // Some tickers have 2+2 or 2+3 char teams
    const mid = Math.floor(teams.length / 2);
    return [teams.substring(0, mid), teams.substring(mid)];
  }
  return [];
}

// Win probability cache: eventId -> { homeWinProb, awayWinProb, fetchTime }
const winProbCache = new Map();

/**
 * Fetch ESPN win probability for NBA/MLB games.
 * Returns { homeWinProb, awayWinProb } or null if unavailable.
 */
async function fetchWinProbability(eventId, sport) {
  if (!eventId || !sport) return null;

  // Only NBA and MLB have ESPN win probability
  const sportPath = sport.includes('basketball') ? 'basketball/nba'
    : sport.includes('baseball') ? 'baseball/mlb'
    : null;
  if (!sportPath) return null;

  // Cache for 30s
  const cached = winProbCache.get(eventId);
  if (cached && Date.now() - cached.fetchTime < 30000) return cached;

  try {
    // Fetch with high limit to get all snapshots, take the last one
    const url = `https://sports.core.api.espn.com/v2/sports/${sportPath}/events/${eventId}/competitions/${eventId}/probabilities?limit=500`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();

    // Get the latest probability snapshot (last item = most recent play)
    const items = data.items || [];
    const latest = items[items.length - 1];
    if (!latest) return null;

    const result = {
      homeWinProb: latest.homeWinPercentage ?? null,
      awayWinProb: latest.awayWinPercentage ?? null,
      tieProb: latest.tiePercentage ?? 0,
      fetchTime: Date.now(),
    };
    winProbCache.set(eventId, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Estimate NHL win probability from score, period, and time remaining.
 * Simple logistic model based on goal differential and game progress.
 */
function estimateNHLWinProb(score1, score2, period, clock) {
  const goalDiff = score1 - score2; // positive = team1 leading
  // Parse minutes remaining in current period
  const [min, sec] = (clock || '20:00').split(':').map(Number);
  const periodMinLeft = (min || 0) + (sec || 0) / 60;
  // Total minutes remaining (20 min periods, 3 periods)
  const periodsLeft = Math.max(0, 3 - period);
  const totalMinLeft = periodsLeft * 20 + periodMinLeft;
  const gameProgress = 1 - totalMinLeft / 60; // 0 = start, 1 = end

  // Logistic function: as game progresses, goal diff matters more
  // At start: even diff = ~50/50. At end: any lead ≈ certain win.
  const k = 1.5 + gameProgress * 3; // steepness increases as game progresses
  const prob = 1 / (1 + Math.exp(-k * goalDiff));
  return Math.max(0.02, Math.min(0.98, prob)); // clamp to 2%-98%
}

/**
 * Get win probability for a specific team in a game.
 * Returns { winProb, source } or null.
 * winProb is for the team identified by teamIndex in the ticker.
 */
async function getWinProbForTicker(ticker, scoreCtx) {
  if (!scoreCtx || !scoreCtx.isLive) return null;

  // Extract which team this ticker is for (last segment after dash)
  const parts = ticker.split('-');
  const tickerTeam = parts[parts.length - 1];
  const teamIdx = scoreCtx.teams.indexOf(tickerTeam);
  if (teamIdx === -1) return null;

  const sport = scoreCtx.sport;

  // NHL: use our own model (ESPN doesn't have win prob for NHL)
  if (sport && sport.includes('hockey')) {
    const s1 = scoreCtx.scores[0] ?? 0;
    const s2 = scoreCtx.scores[1] ?? 0;
    const prob = estimateNHLWinProb(s1, s2, scoreCtx.period, scoreCtx.clock);
    // prob is for team1 (index 0). If our team is index 1, invert.
    const teamProb = teamIdx === 0 ? prob : 1 - prob;
    return { winProb: teamProb, source: 'nhl-model' };
  }

  // NBA/MLB: use ESPN win probability
  if (!scoreCtx.eventId) return null;
  const wp = await fetchWinProbability(scoreCtx.eventId, sport);
  if (!wp || wp.homeWinProb == null) return null;

  // Match team to home/away
  const isHome = scoreCtx.isHome[teamIdx];
  if (isHome == null) return null;
  const teamProb = isHome ? wp.homeWinProb : wp.awayWinProb;
  return { winProb: teamProb, source: 'espn' };
}

/**
 * Check live scores to validate or boost momentum signals.
 * Returns an object with score context for logging.
 */
async function getScoreContext(ticker) {
  const teams = extractTeams(ticker);
  if (teams.length < 2) return null;

  const scores = await fetchLiveScores();
  const team1 = scores.get(teams[0]);
  const team2 = scores.get(teams[1]);

  if (!team1 && !team2) return null;

  const score1 = team1?.score ?? '?';
  const score2 = team2?.score ?? '?';
  const status = team1?.status || team2?.status || 'unknown';
  const period = team1?.period || team2?.period || '?';
  const clock = team1?.clock || team2?.clock || '';

  return {
    teams,
    scores: [score1, score2],
    status,
    period,
    clock,
    sport: team1?.sport || team2?.sport || null,
    eventId: team1?.eventId || team2?.eventId || null,
    isHome: [team1?.isHome ?? null, team2?.isHome ?? null],
    display: `${teams[0]} ${score1} - ${teams[1]} ${score2} (${status === 'STATUS_IN_PROGRESS' ? `P${period} ${clock}` : status})`,
    isLive: status === 'STATUS_IN_PROGRESS',
    isFinal: status === 'STATUS_FINAL',
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
