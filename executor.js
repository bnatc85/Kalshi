/**
 * Executes trades on Kalshi only.
 * In dry-run mode, just logs what it would do.
 */

import { config } from './config.js';
import { getKalshiClient, fetchKalshiMarket } from './fetcher.js';

/**
 * Enter a position on Kalshi based on divergence signal.
 */
export async function enterPosition(signal, marketConfig, contracts) {
  const side = signal.tradeSide;  // 'yes' or 'no'
  const price = signal.entryPrice;
  const prefix = config.dryRun ? '[DRY RUN]' : '[LIVE]';

  console.log(`\n${prefix} ENTER: ${marketConfig.label}`);
  console.log(`  Side: BUY ${side.toUpperCase()} on Kalshi @ ${(price * 100).toFixed(1)}c`);
  console.log(`  Contracts: ${contracts} | Cost: $${(price * contracts).toFixed(2)}`);
  console.log(`  Signal: Kalshi=${(signal.kalshiPrice * 100).toFixed(1)}c  Poly=${(signal.polyPrice * 100).toFixed(1)}c  Divergence=${signal.divergenceBps.toFixed(0)}bps`);

  if (config.dryRun) return { success: true, dryRun: true };

  try {
    const markets = await fetchKalshiMarket(marketConfig.kalshiTicker);
    if (!markets.length) throw new Error(`Market not found: ${marketConfig.kalshiTicker}`);

    const market = markets[0];
    console.log(`  Market data: id=${market.marketId} outcomes=${JSON.stringify(market.outcomes?.map(o => ({label: o.label, id: o.outcomeId})))}`);

    const outcome = side === 'yes'
      ? market.outcomes?.find(o => o.label === 'Yes') ?? market.outcomes?.[0]
      : market.outcomes?.find(o => o.label === 'No')  ?? market.outcomes?.[1];

    if (!outcome) throw new Error(`Outcome "${side}" not found in ${JSON.stringify(market.outcomes)}`);

    // Use the outcome object directly (pmxt resolves marketId/outcomeId from it)
    // Price in decimal (0-1), round up by 1c to ensure fill
    const limitPrice = Math.round((price + 0.01) * 100) / 100;
    console.log(`  Placing order: outcome=${outcome.outcomeId} side=buy type=limit price=${limitPrice} amount=${contracts}`);

    const order = await getKalshiClient().createOrder({
      outcome,
      side: 'buy',
      type: 'limit',
      amount: contracts,
      price: limitPrice,
    });

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
    const markets = await fetchKalshiMarket(marketConfig.kalshiTicker);
    if (!markets.length) throw new Error(`Market not found: ${marketConfig.kalshiTicker}`);

    const market = markets[0];
    const outcome = position.tradeSide === 'yes'
      ? market.outcomes.find(o => o.label === 'Yes') ?? market.outcomes[0]
      : market.outcomes.find(o => o.label === 'No')  ?? market.outcomes[1];

    if (!outcome) throw new Error(`Outcome "${position.tradeSide}" not found`);

    // Sell at 1c below current to ensure fill
    const order = await getKalshiClient().createOrder({
      outcome,
      side: 'sell',
      type: 'limit',
      amount: position.contracts,
      price: 1,  // sell at 1c to ensure fill (market sell equivalent)
    });

    console.log(`  Exit order placed: ${JSON.stringify(order)}`);
    return { success: true, order };
  } catch (e) {
    console.error(`  Exit FAILED: ${e.message}`);
    return { success: false, error: e.message };
  }
}
