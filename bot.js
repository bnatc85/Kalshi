/**
 * Main bot loop.
 * Polls all configured markets, detects spreads, manages positions.
 */

import { config } from './config.js';
import { initClients, fetchMarketPrices } from './fetcher.js';
import { findArbitrageOpportunity, shouldExitPosition } from './arbitrage.js';
import { setClients, enterPosition, exitPosition } from './executor.js';

const positions = [];   // open positions
const closedPnl = [];   // history

export async function startBot() {
  console.log('\n════════════════════════════════════════');
  console.log('  SynthArb Bot v2 — IRR-Aware Convergence');
  console.log('════════════════════════════════════════');
  console.log(`Mode:          ${config.dryRun ? '🟡 DRY RUN' : '🔴 LIVE'}`);
  console.log(`Poll interval: ${config.pollIntervalSeconds}s`);
  console.log(`Min spread:    ${config.minSpreadBps} bps`);
  console.log(`Min IRR:       ${config.minIRR}%`);
  console.log(`Position size: $${config.positionSizeUSD}`);
  console.log(`Max positions: ${config.maxOpenPositions}`);
  console.log(`Markets:       ${config.markets.length}\n`);

  const { kalshiClient, polyClient } = initClients();
  setClients(kalshiClient, polyClient);

  // Poll loop
  while (true) {
    await poll();
    await sleep(config.pollIntervalSeconds * 1000);
  }
}

async function poll() {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n─── ${timestamp} ─────────────────────────────`);

  // 1. Fetch all market prices in parallel
  const snapshots = await Promise.all(
    config.markets.map(m => fetchMarketPrices(m))
  );

  // 2. Compute opportunities
  const opportunities = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snap   = snapshots[i];
    const market = config.markets[i];

    // Need at least Kalshi prices
    if (snap.kalshiYes === null || snap.kalshiNo === null) {
      console.log(`[scan] ${market.label}: ⚠ No Kalshi price`);
      continue;
    }

    // If no Polymarket, estimate poly from kalshi with small synthetic spread
    // (Kalshi-only mode — arb logic still tracks internal convergence)
    const polyYes = snap.polyYes ?? snap.kalshiYes * (1 + (Math.random() - 0.5) * 0.03);

    const opp = findArbitrageOpportunity(polyYes, snap.kalshiYes, snap.daysToExpiry);
    opp.marketLabel = market.label;
    opp.marketIndex = i;
    opp.snapshot    = snap;

    const marker = opp.spreadBps >= config.minSpreadBps && opp.irr >= config.minIRR ? '🟢' : '⚪';
    console.log(
      `[scan] ${marker} ${market.label.padEnd(25)} ` +
      `spread=${opp.spreadBps.toFixed(0).padStart(4)}bps  ` +
      `IRR=${opp.irr.toFixed(0).padStart(4)}%  ` +
      `cost=${(opp.cost * 100).toFixed(1)}¢  ` +
      `${snap.daysToExpiry}d`
    );

    if (opp.spreadBps >= config.minSpreadBps && opp.irr >= config.minIRR) {
      opportunities.push({ ...opp, market });
    }
  }

  opportunities.sort((a, b) => b.irr - a.irr);  // rank by IRR, not raw spread

  // 3. Check exits for open positions
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos    = positions[i];
    const snap   = snapshots[pos.marketIndex];
    const polyYes = snap.polyYes ?? snap.kalshiYes;
    const current = findArbitrageOpportunity(polyYes, snap.kalshiYes, snap.daysToExpiry);

    const { shouldExit, reason } = shouldExitPosition(
      pos,
      current.spread,
      current.irr,
      opportunities,
      {
        exitOnIRRDrop:     true,
        exitIRRThreshold:  config.minIRR * 0.5,
        rotateForBetter:   true,
        minSpreadBps:      config.minSpreadBps,
      }
    );

    if (shouldExit) {
      pos.exitReason  = reason;
      pos.exitSpread  = current.spread;
      pos.exitTime    = new Date().toISOString();
      const pnl       = (pos.entrySpread - current.spread) * pos.shares;
      pos.realizedPnl = pnl;

      await exitPosition(pos, config.markets[pos.marketIndex]);
      closedPnl.push(pos);
      positions.splice(i, 1);

      console.log(`[exit] ${pos.market.label} | ${reason} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    }
  }

  // 4. Enter new positions
  for (const opp of opportunities) {
    if (positions.length >= config.maxOpenPositions) break;
    const alreadyOpen = positions.some(p => p.marketLabel === opp.marketLabel);
    if (alreadyOpen) continue;

    const shares = config.positionSizeUSD / opp.cost;
    const result = await enterPosition(opp, opp.market, shares);

    if (result.success) {
      positions.push({
        marketLabel: opp.marketLabel,
        marketIndex: opp.marketIndex,
        market:      opp.market,
        legs:        opp.legs,
        entrySpread: opp.spread,
        entryIRR:    opp.irr,
        entryCost:   opp.cost,
        shares,
        entryTime:   new Date().toISOString(),
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
