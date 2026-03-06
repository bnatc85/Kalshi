/**
 * Executes trades on Kalshi only.
 * In dry-run mode, just logs what it would do.
 */

import { config } from './config.js';
import { getKalshiClient, fetchKalshiMarket } from './fetcher.js';

// Absolute maximum contracts per order — even if math is wrong,
// this limits worst-case spend to MAX_CONTRACTS * $1 = $25
const MAX_CONTRACTS = 25;

/**
 * Enter a position on Kalshi based on divergence signal.
 */
export async function enterPosition(signal, marketConfig, contracts) {
  const side = signal.tradeSide;  // 'yes' or 'no'
  const price = signal.entryPrice;
  const prefix = config.dryRun ? '[DRY RUN]' : '[LIVE]';

  // Hard safety cap: never spend more than positionSizeUSD
  const limitPrice = Math.round((price + 0.01) * 100) / 100;

  // Clamp contracts to absolute maximum
  if (contracts > MAX_CONTRACTS) {
    console.warn(`  CLAMPED: ${contracts} contracts -> ${MAX_CONTRACTS} (hard limit)`);
    contracts = MAX_CONTRACTS;
  }

  const maxCost = limitPrice * contracts;
  if (maxCost > config.positionSizeUSD * 1.05) {
    console.error(`  BLOCKED: estimated cost $${maxCost.toFixed(2)} exceeds limit $${config.positionSizeUSD}`);
    return { success: false, error: 'cost exceeds position size limit' };
  }

  // Sanity check: if entry price is below 5c or above 97c, something is likely wrong
  if (price < 0.05 || price > 0.97) {
    console.error(`  BLOCKED: entry price ${(price*100).toFixed(1)}c is outside safe range (5c-97c)`);
    return { success: false, error: 'entry price outside safe range' };
  }

  console.log(`\n${prefix} ENTER: ${marketConfig.label}`);
  console.log(`  Side: BUY ${side.toUpperCase()} on Kalshi @ ${(price * 100).toFixed(1)}c (limit ${(limitPrice * 100).toFixed(1)}c)`);
  console.log(`  Contracts: ${contracts} | Max cost: $${maxCost.toFixed(2)}`);
  console.log(`  Signal: Kalshi=${(signal.kalshiPrice * 100).toFixed(1)}c  Poly=${(signal.polyPrice * 100).toFixed(1)}c  Divergence=${signal.divergenceBps.toFixed(0)}bps`);

  if (config.dryRun) return { success: true, dryRun: true };

  try {
    const markets = await fetchKalshiMarket(marketConfig.kalshiTicker);
    if (!markets.length) throw new Error(`Market not found: ${marketConfig.kalshiTicker}`);

    const market = markets[0];

    // CRITICAL: verify the returned market matches what we asked for
    if (market.marketId !== marketConfig.kalshiTicker) {
      throw new Error(`WRONG MARKET: asked for ${marketConfig.kalshiTicker}, got ${market.marketId}`);
    }

    console.log(`  Market data: id=${market.marketId} outcomes=${JSON.stringify(market.outcomes?.map(o => ({label: o.label, id: o.outcomeId})))}`);

    // Use Kalshi REST API directly via callApi (pmxtjs createOrder is broken)
    const kalshiOrder = {
      ticker: marketConfig.kalshiTicker,
      action: 'buy',
      side,
      type: 'limit',
      count: contracts,
      ...(side === 'yes'
        ? { yes_price: Math.round(limitPrice * 100) }
        : { no_price: Math.round(limitPrice * 100) }),
    };
    console.log(`  Placing order: ${JSON.stringify(kalshiOrder)}`);

    const order = await getKalshiClient().callApi('CreateOrder', kalshiOrder);

    console.log(`  Order placed: ${JSON.stringify(order)}`);
    return { success: true, dryRun: false, order };
  } catch (e) {
    console.error(`  Order FAILED: ${e.message}`);
    console.error(`  Full error: ${JSON.stringify(e, Object.getOwnPropertyNames(e))}`);
    return { success: false, error: e.message };
  }
}

/**
 * Exit a position — sell on Kalshi.
 */
export async function exitPosition(position, marketConfig) {
  const prefix = config.dryRun ? '[DRY RUN]' : '[LIVE]';
  console.log(`\n${prefix} EXIT: ${marketConfig.label} (${position.exitReason})`);

  if (config.dryRun) return { success: true, dryRun: true };

  try {
    const side = position.tradeSide;
    const sellQty = Math.min(position.contracts, MAX_CONTRACTS);
    const kalshiOrder = {
      ticker: marketConfig.kalshiTicker,
      action: 'sell',
      side,
      type: 'limit',
      count: sellQty,
      ...(side === 'yes' ? { yes_price: 1 } : { no_price: 1 }),  // 1c to ensure fill
    };
    console.log(`  Exit order: ${JSON.stringify(kalshiOrder)}`);

    const order = await getKalshiClient().callApi('CreateOrder', kalshiOrder);

    console.log(`  Exit order placed: ${JSON.stringify(order)}`);
    return { success: true, order };
  } catch (e) {
    console.error(`  Exit FAILED: ${e.message}`);
    return { success: false, error: e.message };
  }
}
