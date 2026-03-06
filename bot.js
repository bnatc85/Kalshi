/**
 * Main bot loop.
 * Polls configured markets, detects Kalshi vs Polymarket divergence,
 * trades on Kalshi only using Polymarket as a price signal.
 */

import { config, loadApprovedMarkets } from './config.js';
import { initClients, fetchMarketPrices, fetchOrderBook, getKalshiClient } from './fetcher.js';
import { findDivergence, shouldExitPosition } from './arbitrage.js';
import { enterPosition, exitPosition } from './executor.js';

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

  // 3b. Auto-sell: check real Kalshi positions, sell if order book bid > entry price
  try {
    const livePositions = await getKalshiClient().fetchPositions();
    for (const pos of livePositions) {
      if (pos.size <= 0) continue;

      const isYes = pos.outcomeLabel === 'Yes';
      const ticker = pos.marketId;

      // Fetch the order book to find real bid prices
      let bestBid = null;
      try {
        const ob = await fetchOrderBook(ticker);
        // Best bid = what someone will actually pay for our contracts right now
        if (isYes) {
          bestBid = ob.spread.yesBid;
        } else {
          // For NO positions: best NO bid, or inferred from YES ask (1 - yesAsk)
          bestBid = ob.spread.noBid
            ?? (ob.spread.yesAsk != null ? Math.round((1 - ob.spread.yesAsk) * 100) / 100 : null);
        }
      } catch (e) {
        console.warn(`[auto-sell] Order book failed for ${ticker}: ${e.message}`);
      }
      await sleep(1500);

      const entry = pos.entryPrice;
      const minSellPrice = Math.round((entry + 0.01) * 100) / 100; // at least 1c profit per contract

      console.log(
        `[auto-sell] ${ticker} ${pos.outcomeLabel} | ${pos.size} contracts | ` +
        `entry=${(entry*100).toFixed(1)}c  bestBid=${bestBid != null ? (bestBid*100).toFixed(1)+'c' : 'none'}  ` +
        `minSell=${(minSellPrice*100).toFixed(1)}c`
      );

      if (bestBid == null) {
        console.log(`[auto-sell]   -> no bid available, holding`);
        continue;
      }

      if (bestBid < minSellPrice) {
        const gap = ((minSellPrice - bestBid) * 100).toFixed(1);
        console.log(`[auto-sell]   -> bid ${gap}c below profitable sell price, holding`);
        continue;
      }

      // Bid is above entry + 1c — we can sell profitably
      // Place limit sell at the best bid price to fill immediately
      const sellPrice = bestBid;
      const profit = ((sellPrice - entry) * pos.size).toFixed(2);
      console.log(`[auto-sell]   -> PROFITABLE: selling ${pos.size} @ ${(sellPrice*100).toFixed(1)}c (profit ~$${profit})`);

      if (config.dryRun) {
        console.log(`[auto-sell]   -> DRY RUN: would sell`);
        continue;
      }

      try {
        const markets = await getKalshiClient().fetchMarkets({ ticker, limit: 1 });
        if (!markets.length) { console.warn(`[auto-sell]   -> market not found`); continue; }

        const market = markets[0];
        const outcome = market.outcomes?.find(o => o.outcomeId === pos.outcomeId)
          ?? market.outcomes?.find(o => o.label === pos.outcomeLabel);
        if (!outcome) { console.warn(`[auto-sell]   -> outcome not found`); continue; }

        const order = await getKalshiClient().createOrder({
          outcome,
          side: 'sell',
          type: 'limit',
          amount: pos.size,
          price: sellPrice,
        });
        console.log(`[auto-sell]   -> SOLD: ${JSON.stringify(order)}`);
      } catch (e) {
        console.error(`[auto-sell]   -> sell failed: ${e.message}`);
      }
      await sleep(1500);
    }
  } catch (e) {
    console.warn(`[auto-sell] Failed to check positions: ${e.message}`);
  }

  // 4. Enter new positions
  // Fetch real Kalshi positions to avoid re-buying markets we already hold
  let liveTickerSet = new Set();
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

    if (result.success) {
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
