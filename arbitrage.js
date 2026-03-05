/**
 * Core arbitrage math — no API calls here, pure calculation.
 * Used by both the bot and the scanner.
 */

/**
 * Given live prices from both platforms for the same outcome,
 * compute the best synthetic arb opportunity (if any).
 *
 * Strategy A: Buy YES on Poly + Buy NO on Kalshi
 * Strategy B: Buy YES on Kalshi + Buy NO on Poly
 *
 * Returns null if no profitable spread exists.
 */
export function findArbitrageOpportunity(polyYes, kalshiYes, daysToExpiry) {
  const polyNo   = 1 - polyYes;
  const kalshiNo = 1 - kalshiYes;

  const costA = polyYes + kalshiNo;   // YES on Poly, NO on Kalshi
  const costB = kalshiYes + polyNo;   // YES on Kalshi, NO on Poly

  const bestCost     = Math.min(costA, costB);
  const strategy     = costA <= costB ? 'A' : 'B';
  const spread       = 1 - bestCost;
  const spreadBps    = spread * 10000;
  const irr          = calcAnnualizedIRR(spread, bestCost, daysToExpiry);

  return {
    strategy,       // 'A' or 'B'
    cost: bestCost, // combined cost of both legs
    spread,         // gross profit per dollar
    spreadBps,
    irr,            // annualized return
    costA,
    costB,
    // Describe the legs
    legs: strategy === 'A'
      ? { yesPlatform: 'polymarket', noPlatform: 'kalshi', yesPrice: polyYes,   noPrice: kalshiNo }
      : { yesPlatform: 'kalshi',     noPlatform: 'polymarket', yesPrice: kalshiYes, noPrice: polyNo },
  };
}

/**
 * Annualized IRR = (profit/cost) × (365/daysToExpiry)
 * This is the key metric — a tight spread with few days remaining
 * can massively outrank a large spread with months to go.
 */
export function calcAnnualizedIRR(spread, cost, daysToExpiry) {
  if (daysToExpiry <= 0 || cost <= 0) return 0;
  return (spread / cost) * (365 / daysToExpiry) * 100;
}

/**
 * Decide whether to exit an open position.
 * Returns { shouldExit, reason } 
 */
export function shouldExitPosition(position, currentSpread, currentIRR, allOpportunities, config) {
  // 1. Spread has closed — take profit
  if (currentSpread < 0.003) {
    return { shouldExit: true, reason: 'CONVERGED' };
  }

  // 2. IRR dropped below threshold — redeploy capital
  if (config.exitOnIRRDrop && currentIRR < config.exitIRRThreshold) {
    return { shouldExit: true, reason: 'IRR_DROP' };
  }

  // 3. Rotate — a much better opportunity exists elsewhere
  if (config.rotateForBetter) {
    const betterExists = allOpportunities.some(
      o => o.marketLabel !== position.marketLabel &&
           o.spreadBps >= config.minSpreadBps * 1.8 &&
           o.irr > position.entryIRR * 1.5
    );
    const spreadHalfClosed = currentSpread < position.entrySpread * 0.45;
    if (betterExists && spreadHalfClosed) {
      return { shouldExit: true, reason: 'ROTATE' };
    }
  }

  return { shouldExit: false, reason: null };
}
