/**
 * Executes arb orders on both platforms simultaneously.
 * In dry-run mode, just logs what it would do.
 */

import { config } from './config.js';

let kalshiClient = null;
let polyClient   = null;

export function setClients(k, p) {
  kalshiClient = k;
  polyClient   = p;
}

/**
 * Enter a synthetic arb position.
 * Buys YES on one platform and NO on the other simultaneously.
 */
export async function enterPosition(opportunity, marketConfig, shares) {
  const { legs } = opportunity;
  const prefix = config.dryRun ? '[DRY RUN] Would execute' : 'EXECUTING';

  console.log(`\n${prefix}: ${marketConfig.label}`);
  console.log(`  Leg 1: BUY YES on ${legs.yesPlatform} @ ${(legs.yesPrice * 100).toFixed(1)}¢`);
  console.log(`  Leg 2: BUY NO  on ${legs.noPlatform}  @ ${(legs.noPrice  * 100).toFixed(1)}¢`);
  console.log(`  Shares: ${shares.toFixed(0)} | Cost: $${(opportunity.cost * shares).toFixed(2)} | Expected gross: $${shares.toFixed(2)}`);

  if (config.dryRun) return { success: true, dryRun: true };

  // Execute both legs in parallel to minimize price drift between fills
  const results = await Promise.allSettled([
    placeLeg(legs.yesPlatform, marketConfig, 'Yes', 'buy', legs.yesPrice, shares),
    placeLeg(legs.noPlatform,  marketConfig, 'No',  'buy', legs.noPrice,  shares),
  ]);

  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) {
    console.error('[executor] ⚠ Partial fill — manual intervention may be needed!');
    failures.forEach(f => console.error('  →', f.reason?.message));
    return { success: false, partialFill: true };
  }

  return { success: true, dryRun: false };
}

/**
 * Exit a position — sell both legs.
 */
export async function exitPosition(position, marketConfig) {
  const prefix = config.dryRun ? '[DRY RUN] Would exit' : 'EXITING';
  console.log(`\n${prefix}: ${marketConfig.label} (${position.exitReason})`);

  if (config.dryRun) return { success: true, dryRun: true };

  const results = await Promise.allSettled([
    placeLeg(position.legs.yesPlatform, marketConfig, 'Yes', 'sell', null, position.shares),
    placeLeg(position.legs.noPlatform,  marketConfig, 'No',  'sell', null, position.shares),
  ]);

  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) {
    console.error('[executor] ⚠ Exit partial fill!');
    return { success: false, partialFill: true };
  }

  return { success: true };
}

async function placeLeg(platform, marketConfig, outcome, side, price, shares) {
  const slug = platform === 'kalshi' ? marketConfig.kalshiSlug : marketConfig.polySlug;

  const client = platform === 'kalshi' ? kalshiClient : polyClient;
  if (!client) throw new Error(`No client for platform: ${platform}`);

  // Fetch the outcomeId (required by pmxt)
  const markets    = await client.fetchMarkets({ slug, limit: 1 });
  const market     = markets[0];
  const outcomeObj = market.outcomes.find(o => o.label === outcome);
  if (!outcomeObj) throw new Error(`Outcome "${outcome}" not found on ${platform}`);

  return await client.createOrder({
    outcomeId: outcomeObj.outcomeId,
    side,
    type:   'market',  // market orders for instant fill
    amount: Math.floor(shares),
  });
}
