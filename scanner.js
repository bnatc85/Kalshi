/**
 * One-shot market scanner — no trading, just prints current divergences.
 * Run: npm run scan
 */

import { validateConfig, config } from './config.js';
import { initClients, fetchMarketPrices } from './fetcher.js';
import { findDivergence } from './arbitrage.js';

validateConfig();
initClients();

console.log('\n=== Signal BonBon Market Scanner ===\n');
console.log(`Scanning ${config.markets.length} markets...\n`);

// Fetch sequentially to avoid Kalshi API rate limits (429)
const snapshots = [];
for (const market of config.markets) {
  snapshots.push(await fetchMarketPrices(market));
  await new Promise(r => setTimeout(r, 500));
}

let found = 0;
for (let i = 0; i < snapshots.length; i++) {
  const snap = snapshots[i];
  const market = config.markets[i];

  if (snap.kalshiPrice === null) {
    console.log(`  [!] ${market.label}: Could not fetch Kalshi prices`);
    console.log();
    continue;
  }
  if (snap.polyPrice === null) {
    console.log(`  [!] ${market.label}: Could not fetch Polymarket prices`);
    console.log(`      Kalshi: ${(snap.kalshiPrice * 100).toFixed(1)}c  |  ${snap.daysToExpiry}d to expiry`);
    console.log();
    continue;
  }

  const sig = findDivergence(snap.polyPrice, snap.kalshiPrice, snap.kalshiSide, snap.daysToExpiry);
  const meets = sig.divergenceBps >= config.minDivergenceBps && sig.irr >= config.minIRR;
  if (meets) found++;

  const contracts = Math.floor(config.positionSizeUSD / sig.entryPrice);
  const profitUsd = (sig.expectedProfit * contracts).toFixed(2);

  console.log(`${meets ? '>>' : '  '} ${market.label}`);
  console.log(`   Kalshi: ${(snap.kalshiPrice * 100).toFixed(1)}c  |  Poly: ${(snap.polyPrice * 100).toFixed(1)}c  (raw K_YES=${(snap.kalshiYes*100).toFixed(1)}c K_NO=${(snap.kalshiNo*100).toFixed(1)}c)`);
  console.log(`   Divergence: ${sig.divergenceBps.toFixed(0)} bps  |  IRR: ${sig.irr.toFixed(0)}%  |  ${snap.daysToExpiry}d to expiry`);
  if (meets) {
    console.log(`   >>> Recommend: BUY ${sig.tradeSide.toUpperCase()} "${market.label}" on Kalshi @ ${(sig.entryPrice * 100).toFixed(1)}c × ${contracts} contracts ($${config.positionSizeUSD}) → expected profit $${profitUsd}`);
  } else {
    console.log(`   Signal: BUY ${sig.tradeSide.toUpperCase()} on Kalshi @ ${(sig.entryPrice * 100).toFixed(1)}c (below threshold)`);
  }
  console.log();
}

console.log(`Found ${found} signal${found !== 1 ? 's' : ''} meeting thresholds (${config.minDivergenceBps}bps / ${config.minIRR}% IRR).`);
console.log('Run "npm run dry" to start the bot in dry-run mode.\n');
