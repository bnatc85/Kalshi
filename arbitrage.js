/**
 * Core signal math — no API calls here, pure calculation.
 *
 * Strategy: Use Polymarket price as a "fair value" signal.
 * When Kalshi diverges from Polymarket, trade on Kalshi
 * in the direction of convergence.
 */

/**
 * Given normalized prices (already adjusted for compareMode by fetcher),
 * compute the divergence and recommended Kalshi trade.
 *
 * If polyPrice > kalshiPrice → Kalshi is underpriced → BUY on Kalshi
 * If polyPrice < kalshiPrice → Kalshi is overpriced → SELL (or buy the other side)
 */
export function findDivergence(polyPrice, kalshiPrice, kalshiSide, daysToExpiry) {
  const divergence = polyPrice - kalshiPrice;          // positive = Kalshi is cheap
  const absDivergence = Math.abs(divergence);
  const divergenceBps = absDivergence * 10000;

  // Trade direction: if Kalshi is cheap, buy the kalshiSide
  // If Kalshi is expensive, buy the opposite side
  let tradeSide, entryPrice;
  if (divergence > 0) {
    // Kalshi is cheap — buy this side
    tradeSide = kalshiSide;
    entryPrice = kalshiPrice;
  } else {
    // Kalshi is expensive — buy the other side
    tradeSide = kalshiSide === 'yes' ? 'no' : 'yes';
    entryPrice = 1 - kalshiPrice;
  }

  const expectedProfit = absDivergence;
  const irr = calcAnnualizedIRR(expectedProfit, entryPrice, daysToExpiry);

  return {
    tradeSide,          // 'yes' or 'no' — what to buy on Kalshi
    entryPrice,         // price of the side we're buying
    divergence,         // raw divergence (signed, positive = Kalshi cheap)
    divergenceBps,      // absolute divergence in bps
    expectedProfit,     // expected profit per contract if prices converge
    irr,                // annualized return
    polyPrice,
    kalshiPrice,
    kalshiSide,
    daysToExpiry,
  };
}

/**
 * Annualized IRR = (profit / cost) * (365 / daysToExpiry) * 100
 */
export function calcAnnualizedIRR(profit, cost, daysToExpiry) {
  if (daysToExpiry <= 0 || cost <= 0) return 0;
  return (profit / cost) * (365 / daysToExpiry) * 100;
}

/**
 * Decide whether to exit an open position.
 */
export function shouldExitPosition(position, currentDivergenceBps, currentDivergence, currentIRR, exitConvergenceBps, minIRR) {
  // 1. Spread has converged — take profit
  if (currentDivergenceBps < exitConvergenceBps) {
    return { shouldExit: true, reason: 'CONVERGED' };
  }

  // 2. Divergence flipped against us
  const wasKalshiCheap = position.entryDivergence > 0;
  const nowFlipped = wasKalshiCheap ? currentDivergence < -0.01 : currentDivergence > 0.01;
  if (nowFlipped) {
    return { shouldExit: true, reason: 'FLIPPED' };
  }

  // 3. IRR too low — capital better used elsewhere
  if (currentIRR < minIRR * 0.5) {
    return { shouldExit: true, reason: 'IRR_DROP' };
  }

  return { shouldExit: false, reason: null };
}
