/**
 * One-shot market scanner — no trading, just prints current opportunities.
 * Good for checking before you turn the bot on.
 *
 * Run: npm run scan
 */

import { validateConfig, config } from './config.js';
import { initClients, fetchMarketPrices } from './fetcher.js';
import { findArbitrageOpportunity } from './arbitrage.js';

validateConfig();
initClients();

console.log('\n=== SynthArb Market Scanner ===\n');
console.log(`Scanning ${config.markets.length} markets...\n`);

const snapshots = await Promise.all(config.markets.map(fetchMarketPrices));

let found = 0;
for (let i = 0; i < snapshots.length; i++) {
  const snap   = snapshots[i];
  const market = config.markets[i];

  if (snap.kalshiYes === null) {
    console.log(`  ⚠  ${market.label}: Could not fetch Kalshi prices`);
    continue;
  }

  const polyYes = snap.polyYes ?? snap.kalshiYes;
  const opp     = findArbitrageOpportunity(polyYes, snap.kalshiYes, snap.daysToExpiry);

  const meets = opp.spreadBps >= config.minSpreadBps && opp.irr >= config.minIRR;
  if (meets) found++;

  console.log(`${meets ? '🟢' : '⚪'} ${market.label}`);
  console.log(`   Kalshi YES: ${(snap.kalshiYes * 100).toFixed(1)}¢  |  Poly YES: ${(polyYes * 100).toFixed(1)}¢`);
  console.log(`   Spread: ${opp.spreadBps.toFixed(0)} bps  |  IRR: ${opp.irr.toFixed(0)}%  |  Cost: ${(opp.cost * 100).toFixed(1)}¢  |  ${snap.daysToExpiry}d to expiry`);
  console.log(`   Strategy ${opp.strategy}: BUY YES on ${opp.legs.yesPlatform} + BUY NO on ${opp.legs.noPlatform}`);
  if (meets) {
    const shares = config.positionSizeUSD / opp.cost;
    console.log(`   → At $${config.positionSizeUSD}: ${shares.toFixed(0)} shares, gross payout $${shares.toFixed(2)}, profit $${(opp.spread * shares).toFixed(2)}`);
  }
  console.log();
}

console.log(`Found ${found} opportunity${found !== 1 ? 'ies' : 'y'} meeting your thresholds.`);
console.log('Run "npm run dry" to start the bot in dry-run mode.\n');
