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

export async function startBot() {
  console.log('\n========================================');
  console.log('  Signal BonBon — Kalshi-Only Divergence Bot');
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
    await poll();
    await sleep(config.pollIntervalSeconds * 1000);
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

  // 3b. Auto-sell: check real Kalshi positions, sell if bid > entry price
  try {
    const livePositions = await getKalshiClient().fetchPositions();
    for (const pos of livePositions) {
      if (pos.size <= 0) continue;

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

      // Determine which outcome we hold.
      // pmxt sets outcomeId to the ticker for both position and market outcomes,
      // and labels are things like "4.50%", "Mars", "Reward" — NOT "Yes"/"No".
      // On Kalshi, the first outcome = YES side, second = NO side.
      // Default to YES (index 0) since that's what most positions are.
      const outcomes = market.outcomes || [];
      let outcome = outcomes[0]; // default to first outcome (YES side)
      let side = 'yes';

      // If there are multiple outcomes and we can match by outcomeId, figure out
      // which index we're at to determine yes vs no
      if (outcomes.length > 1) {
        const matchIdx = outcomes.findIndex(o => o.outcomeId === pos.outcomeId);
        if (matchIdx === 1) {
          outcome = outcomes[1];
          side = 'no';
        }
      }

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

          if (side === 'yes' && yesBids.length) {
            bestBid = yesBids[yesBids.length - 1][0] / 100;
          } else if (side === 'no' && noBids.length) {
            bestBid = noBids[noBids.length - 1][0] / 100;
          }
          // If no direct bids, infer from the other side
          // YES bid ≈ 1 - lowest NO price (best NO ask)
          if (bestBid == null && side === 'yes' && noBids.length) {
            bestBid = Math.round((1 - noBids[0][0] / 100) * 100) / 100;
          } else if (bestBid == null && side === 'no' && yesBids.length) {
            bestBid = Math.round((1 - yesBids[0][0] / 100) * 100) / 100;
          }

          console.log(`[auto-sell] ${ticker} book: yesBids=${yesBids.length} noBids=${noBids.length} bestBid=${bestBid != null ? (bestBid*100).toFixed(1)+'c' : 'none'}`);
        } else {
          console.warn(`[auto-sell] ${ticker} orderbook HTTP ${obResp.status}`);
        }
      } catch (e) {
        console.warn(`[auto-sell] ${ticker} orderbook error: ${e.message}`);
      }
      await sleep(1500);

      // Look up entry price: first from our trade ledger, then from API
      const savedTrade = getOpenTrade(ticker);
      const entry = savedTrade?.entryPrice ?? (pos.entryPrice > 0 ? pos.entryPrice : null);
      const isAccidentalPosition = ticker === 'KXFED-26JUN-T4.50';

      let minSellPrice;
      if (entry != null && entry > 0) {
        // We know what we paid — require at least 1c profit (or accept 5c loss for accidental)
        const maxLossPerContract = isAccidentalPosition ? 0.05 : -0.01;
        minSellPrice = Math.round((entry - maxLossPerContract) * 100) / 100;
      } else if (isAccidentalPosition) {
        minSellPrice = 0.01;
      } else {
        console.log(`[auto-sell] ${ticker} ${side.toUpperCase()} | ${pos.size} contracts | no entry price, holding`);
        continue;
      }

      const entrySource = savedTrade ? 'ledger' : (pos.entryPrice > 0 ? 'api' : '?');
      console.log(
        `[auto-sell] ${ticker} ${side.toUpperCase()} | ${pos.size} contracts | ` +
        `entry=${entry != null ? (entry*100).toFixed(1)+'c' : '?'} (${entrySource})  ` +
        `bestBid=${bestBid != null ? (bestBid*100).toFixed(1)+'c' : 'none'}  ` +
        `minSell=${(minSellPrice*100).toFixed(1)}c` +
        (isAccidentalPosition ? '  [ACCIDENTAL - exit ASAP]' : '')
      );

      if (bestBid == null) {
        console.log(`[auto-sell]   -> no bid available, holding`);
        continue;
      }

      if (bestBid < minSellPrice) {
        const gap = ((minSellPrice - bestBid) * 100).toFixed(1);
        console.log(`[auto-sell]   -> bid ${gap}c below min sell price, holding`);
        continue;
      }

      // Place limit sell at the best bid price to fill immediately
      const sellPrice = bestBid;
      console.log(`[auto-sell]   -> SELLING: ${pos.size} @ ${(sellPrice*100).toFixed(1)}c`);

      if (config.dryRun) {
        console.log(`[auto-sell]   -> DRY RUN: would sell`);
        continue;
      }

      try {
        const order = await getKalshiClient().createOrder({
          outcome,
          side: 'sell',
          type: 'limit',
          amount: pos.size,
          price: sellPrice,
        });
        console.log(`[auto-sell]   -> SOLD: ${JSON.stringify(order)}`);
        const pnl = entry ? (sellPrice - entry) * pos.size : null;
        if (pnl != null) console.log(`[auto-sell]   -> PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
        closeTrade(ticker, sellPrice, pnl);
      } catch (e) {
        console.error(`[auto-sell]   -> sell failed: ${e.message}`);
        console.error(`[auto-sell]   -> error details: ${JSON.stringify(e, Object.getOwnPropertyNames(e)).substring(0, 500)}`);
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
      if (p.size > 0) liveTickerSet.add(p.marketId);
    }
    if (liveTickerSet.size > 0) {
      console.log(`[positions] Already holding: ${[...liveTickerSet].join(', ')}`);
    }
  } catch (e) {
    console.warn(`[positions] Could not fetch live positions: ${e.message}`);
  }

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

  // 5. Summary
  const totalPnl = closedPnl.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
  console.log(`\n[summary] Open: ${positions.length}  Closed: ${closedPnl.length}  Realized PnL: $${totalPnl.toFixed(2)}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
