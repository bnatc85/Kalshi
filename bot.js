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

// --- Sports momentum scanner ---
// Price history: ticker -> [{price, time}]
const priceHistory = new Map();
const MOMENTUM_MIN_MOVE = 0.05;     // 5c move required
const MOMENTUM_WINDOW_MS = 5 * 60 * 1000; // within 5 minutes
const MOMENTUM_MIN_PRICE = 0.55;    // don't buy below 55c
const MOMENTUM_MAX_PRICE = 0.70;    // don't buy above 70c
const MOMENTUM_CONTRACTS = 1;       // test with 1 contract
const MOMENTUM_MAX_HOURS = 48;      // markets closing within 48h
// Skip parlays and multi-leg markets
const MOMENTUM_SKIP_PREFIXES = ['KXMVE'];

export async function startBot() {
  console.log('\n========================================');
  console.log('  Signal BonBon — Kalshi-Only Bot');
  console.log('========================================');
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
      if (openSellTickers.has(pos.marketId)) {
        console.log(`[auto-sell] ${pos.marketId}: already has pending sell order, skipping`);
        continue;
      }

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
      console.log(`[auto-sell] ${ticker}: market=${market.marketId}, side=${side.toUpperCase()}, outcome=${outcome.outcomeId} (${outcome.label})`);

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

          console.log(`[auto-sell] ${ticker} book: yesBids=${yesBids.length} noBids=${noBids.length} bestBid=${bestBid != null ? (bestBid*100).toFixed(1)+'c' : 'none'}`);
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
          console.log(`[auto-sell] ${ticker}: entry from Kalshi position: ${(entry*100).toFixed(1)}c (exposure=${raw.market_exposure}c / ${Math.abs(raw.position)} contracts)`);
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
            console.log(`[auto-sell] ${ticker}: entry from ${buyFills.length} fills (${side}): avg ${(entry*100).toFixed(1)}c`);
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
        console.log(`[auto-sell] ${ticker} ${side.toUpperCase()} | ${posSize} contracts | no entry price found, holding`);
        continue;
      }

      const entrySource = entry != null ? 'found' : '?';
      console.log(
        `[auto-sell] ${ticker} ${side.toUpperCase()} | ${posSize} contracts | ` +
        `entry=${entry != null ? (entry*100).toFixed(1)+'c' : '?'} (${entrySource})  ` +
        `bestBid=${bestBid != null ? (bestBid*100).toFixed(1)+'c' : 'none'}  ` +
        `minSell=${(minSellPrice*100).toFixed(1)}c` +
        (isAccidentalPosition ? '  [ACCIDENTAL - exit ASAP]' : '')
      );

      if (bestBid == null) {
        console.log(`[auto-sell]   -> no bid available, holding`);
        continue;
      }

      // If bid is >= 95c, sell immediately — event is nearly resolved,
      // take profit now rather than waiting for settlement
      if (bestBid >= 0.95) {
        console.log(`[auto-sell]   -> bid ${(bestBid*100).toFixed(0)}c >= 95c — selling (near-certain outcome)`);
      } else if (bestBid < minSellPrice) {
        const gap = ((minSellPrice - bestBid) * 100).toFixed(1);
        console.log(`[auto-sell]   -> bid ${gap}c below min sell price, holding`);
        continue;
      }

      // Place limit sell at the best bid price to fill immediately
      // Cap at 25 contracts per order (same as buy side) — remainder sells next cycle
      const sellPrice = bestBid;
      const sellQty = Math.min(posSize, 25);
      console.log(`[auto-sell]   -> SELLING: ${sellQty}${sellQty < posSize ? '/' + posSize : ''} @ ${(sellPrice*100).toFixed(1)}c`);

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
      console.log(`[auto-sell]   -> kalshi order: ${JSON.stringify(kalshiOrderBody)}`);

      try {
        const order = await getKalshiClient().callApi('CreateOrder', kalshiOrderBody);
        const fillCount = order?.order?.fill_count ?? sellQty;
        const fees = parseFloat(order?.order?.taker_fees_dollars || '0');
        const pnl = entry ? (sellPrice - entry) * fillCount - fees : null;
        console.log(
          `[auto-sell]   -> SOLD ${fillCount} contracts` +
          (pnl != null ? ` | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (after $${fees.toFixed(2)} fees)` : '')
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
      console.log(`[positions] Already holding/selling: ${[...liveTickerSet].join(', ')}`);
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

  // 5. Summary — from real Kalshi positions + trade ledger
  const allTrades = loadTrades();
  const openTrades2 = allTrades.filter(t => t.status === 'open');
  const closedTrades = allTrades.filter(t => t.status === 'closed');
  const realizedPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);

  // Count real Kalshi positions
  let liveCount = 0;
  try {
    const live = await getKalshiClient().fetchPositions();
    liveCount = live.filter(p => p.size !== 0).length;
  } catch {}

  console.log(
    `\n[summary] Positions: ${liveCount}  Ledger open: ${openTrades2.length}  Closed: ${closedTrades.length}  ` +
    `Realized PnL: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`
  );
}

/**
 * Sports momentum scanner — fetch markets closing soon, detect 5c+ moves,
 * buy 1 contract on momentum breakouts in the 55-70c range.
 */
async function scanSportsMomentum(liveTickerSet) {
  try {
    // Fetch markets closing within MOMENTUM_MAX_HOURS
    // Kalshi API expects unix timestamps (seconds), not ISO strings
    const now = Date.now();
    const minClose = Math.floor((now - 60 * 1000) / 1000);  // 1min ago
    const maxClose = Math.floor((now + MOMENTUM_MAX_HOURS * 60 * 60 * 1000) / 1000);
    const url = `https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&status=open&min_close_ts=${minClose}&max_close_ts=${maxClose}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`[momentum] Kalshi API ${resp.status}`);
      return;
    }
    const data = await resp.json();
    const markets = data.markets || [];
    if (!markets.length) {
      console.log(`[momentum] No markets closing within ${MOMENTUM_MAX_HOURS}h`);
      return;
    }

    console.log(`[momentum] Scanning ${markets.length} markets closing within ${MOMENTUM_MAX_HOURS}h`);

    let signals = 0;
    const nowMs = Date.now();

    for (const m of markets) {
      const ticker = m.ticker;
      if (!ticker) continue;
      if (MOMENTUM_SKIP_PREFIXES.some(p => ticker.startsWith(p))) continue;

      // Current yes price from the market data (last trade or mid)
      const rawPrice = m.yes_ask > 1 ? m.yes_ask : (m.last_price || 0);
      const yesPrice = rawPrice / 100;
      if (!yesPrice || yesPrice < 0.05) continue;

      // Update price history
      if (!priceHistory.has(ticker)) priceHistory.set(ticker, []);
      const history = priceHistory.get(ticker);
      history.push({ price: yesPrice, time: nowMs });

      // Trim old entries (older than 2x window to keep some context)
      while (history.length > 0 && history[0].time < nowMs - MOMENTUM_WINDOW_MS * 2) {
        history.shift();
      }

      // Need at least 2 data points to detect movement
      if (history.length < 2) continue;

      // Find the price from ~MOMENTUM_WINDOW_MS ago
      const windowStart = nowMs - MOMENTUM_WINDOW_MS;
      const oldEntry = history.find(h => h.time >= windowStart) || history[0];
      const priceMove = yesPrice - oldEntry.price;

      // Check momentum conditions
      if (priceMove < MOMENTUM_MIN_MOVE) continue;
      if (yesPrice < MOMENTUM_MIN_PRICE || yesPrice > MOMENTUM_MAX_PRICE) continue;

      // Skip if we already hold this ticker
      if (liveTickerSet.has(ticker)) continue;

      signals++;
      const title = (m.title || m.subtitle || ticker).substring(0, 50);
      console.log(
        `[momentum] >> ${title} | ${ticker}\n` +
        `[momentum]    ${(oldEntry.price*100).toFixed(0)}c -> ${(yesPrice*100).toFixed(0)}c (+${(priceMove*100).toFixed(0)}c in ${Math.round((nowMs - oldEntry.time)/1000)}s) | closes ${m.close_time || '?'}`
      );

      // Buy 1 contract
      if (config.dryRun) {
        console.log(`[momentum]    DRY RUN: would buy ${MOMENTUM_CONTRACTS} YES @ ${(yesPrice*100).toFixed(0)}c`);
        continue;
      }

      const limitPrice = Math.min(Math.round((yesPrice + 0.02) * 100), 70); // cap at 70c
      try {
        const order = await getKalshiClient().callApi('CreateOrder', {
          ticker,
          action: 'buy',
          side: 'yes',
          type: 'limit',
          count: MOMENTUM_CONTRACTS,
          yes_price: limitPrice,
        });
        const filled = order?.order?.fill_count ?? 0;
        console.log(`[momentum]    BOUGHT ${filled}/${MOMENTUM_CONTRACTS} YES @ ${limitPrice}c`);
        if (filled > 0) {
          recordTrade(ticker, 'yes', yesPrice, limitPrice / 100, filled);
        }
      } catch (e) {
        console.error(`[momentum]    Order failed: ${e.message}`);
      }
      await sleep(1500);
    }

    if (signals === 0) {
      console.log(`[momentum] No momentum signals this cycle`);
    }
  } catch (e) {
    console.warn(`[momentum] Scanner error: ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
