/**
 * 0DTE Credit Spread Bot — Main Loop
 * Mirrors the Kalshi bot's poll-cycle architecture:
 * 1. Check market hours
 * 2. Fetch data (SPY price + option chain)
 * 3. Check exits on open positions
 * 4. Generate entry signals
 * 5. Execute orders
 * 6. Summary
 */

import chalk from 'chalk';
import fs from 'fs';
import config from './config.js';
import {
  login,
  getAccount,
  getBalance,
  getPositions,
  getOptionChain,
  find0DTEExpiration,
  flattenChain,
  placeCreditSpread,
  closeCreditSpread,
  getOrders,
  parseOCC,
} from './tastytrade.js';
import {
  recordPrice,
  generateSignals,
  checkExits,
  getMarketBias,
  getIntradayVolatility,
} from './signals.js';

const TRADES_FILE = new URL('./trades.json', import.meta.url).pathname;

let trades = [];
let cycleCount = 0;
let sessionRefreshTime = 0;

// ── Trade Ledger ────────────────────────────────────────────

function loadTrades() {
  try {
    trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch {
    trades = [];
  }
}

function saveTrades() {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function getOpenTrades() {
  return trades.filter(t => t.status === 'open');
}

// ── Time Helpers ────────────────────────────────────────────

function getETTime() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return {
    hour: et.getHours(),
    minute: et.getMinutes(),
    dayOfWeek: et.getDay(), // 0=Sun, 6=Sat
    dateStr: now.toISOString().split('T')[0],
  };
}

function isMarketOpen() {
  const { hour, minute, dayOfWeek } = getETTime();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false; // weekend
  const minutesSinceMidnight = hour * 60 + minute;
  const open = config.marketOpenHour * 60 + config.marketOpenMinute;
  const close = config.marketCloseHour * 60 + config.marketCloseMinute;
  return minutesSinceMidnight >= open && minutesSinceMidnight < close;
}

// ── Main Poll Cycle ─────────────────────────────────────────

async function pollCycle() {
  cycleCount++;
  const { hour, minute, dateStr } = getETTime();
  const timeStr = `${hour}:${minute.toString().padStart(2, '0')} ET`;

  console.log(chalk.gray(`\n═══ Cycle ${cycleCount} │ ${timeStr} │ ${dateStr} ═══`));

  // Refresh session every 10 minutes
  if (Date.now() - sessionRefreshTime > 10 * 60 * 1000) {
    try {
      await login();
      sessionRefreshTime = Date.now();
    } catch (err) {
      console.log(chalk.red(`  [auth] Session refresh failed: ${err.message}`));
      return;
    }
  }

  // ── Stage 1: Market check ──
  if (!isMarketOpen()) {
    console.log(chalk.yellow('  Market closed. Sleeping...'));
    return;
  }

  // ── Stage 2: Fetch data ──
  let balance, positions, chain, spotPrice;

  try {
    [balance, positions, chain] = await Promise.all([
      getBalance(),
      getPositions(),
      getOptionChain(config.symbol),
    ]);

    // Extract SPY spot price from chain or balance context
    // The chain's first expiration usually has the underlying price
    const cashBalance = parseFloat(balance['cash-balance'] || balance['net-liquidating-value'] || 0);
    console.log(chalk.cyan(`  [balance] Cash: $${cashBalance.toFixed(2)}`));

    // Get spot price — try multiple sources
    spotPrice = extractSpotPrice(chain, balance);
    if (spotPrice) {
      console.log(chalk.cyan(`  [data] SPY: $${spotPrice.toFixed(2)}`));
      recordPrice(spotPrice);
    } else {
      console.log(chalk.yellow('  [data] Could not determine SPY price'));
      return;
    }
  } catch (err) {
    console.log(chalk.red(`  [data] Fetch error: ${err.message}`));
    return;
  }

  // ── Stage 3: Find 0DTE expiration ──
  const exp0DTE = find0DTEExpiration(chain);
  if (!exp0DTE) {
    console.log(chalk.yellow('  [chain] No 0DTE expiration today'));
    return;
  }

  const expirationDate = exp0DTE['expiration-date'];
  console.log(chalk.cyan(`  [chain] 0DTE expiration: ${expirationDate}`));

  // ── Stage 4: Check exits ──
  const openTrades = getOpenTrades();
  if (openTrades.length > 0) {
    console.log(chalk.blue(`  [positions] ${openTrades.length} open trades`));

    // Build current price map for open trades
    const currentPrices = {};
    for (const trade of openTrades) {
      // Estimate current spread value from chain data
      // In production, we'd fetch real-time quotes for each leg
      currentPrices[trade.id] = estimateSpreadValue(trade, spotPrice, expirationDate);
    }

    const exitSignals = checkExits(openTrades, currentPrices);
    for (const signal of exitSignals) {
      console.log(chalk.yellow(`  [exit] ${signal.reason}`));
      try {
        const result = await closeCreditSpread({
          type: signal.trade.type,
          shortStrike: signal.trade.shortStrike,
          longStrike: signal.trade.longStrike,
          expiration: signal.trade.expiration,
          quantity: signal.trade.quantity,
          debitLimit: signal.debitLimit,
        });
        signal.trade.status = 'closed';
        signal.trade.closeTime = new Date().toISOString();
        signal.trade.closeCost = signal.debitLimit;
        signal.trade.pnl = (signal.trade.creditReceived - signal.debitLimit) * signal.trade.quantity * 100;
        const pnlStr = signal.trade.pnl >= 0
          ? chalk.green(`+$${signal.trade.pnl.toFixed(2)}`)
          : chalk.red(`-$${Math.abs(signal.trade.pnl).toFixed(2)}`);
        console.log(chalk.green(`  [exit] Closed ${signal.trade.side} @ $${signal.debitLimit.toFixed(2)} │ PnL: ${pnlStr}`));
        if (result.dryRun) console.log(chalk.gray('    (dry run)'));
        saveTrades();
      } catch (err) {
        console.log(chalk.red(`  [exit] Error closing: ${err.message}`));
      }
    }
  }

  // ── Stage 5: Check for settled (expired) trades ──
  for (const trade of openTrades) {
    if (trade.expiration < getETTime().dateStr) {
      // Expired — determine if it expired worthless (profit) or ITM (loss)
      trade.status = 'expired';
      trade.closeTime = new Date().toISOString();
      // If expired OTM, full credit kept
      // We'll check actual settlement from positions API in next cycle
      console.log(chalk.gray(`  [settled] ${trade.side} expired — checking settlement`));
      saveTrades();
    }
  }

  // ── Stage 6: Generate entry signals ──
  const signals = generateSignals(spotPrice, exp0DTE, openTrades);

  if (!signals.length) {
    const bias = getMarketBias();
    const vol = getIntradayVolatility();
    console.log(chalk.gray(`  [signals] No entries │ bias: ${bias} │ vol: ${vol}`));
  }

  for (const signal of signals) {
    console.log(chalk.magenta(`  [signal] ${signal.side}: sell ${signal.shortStrike} / buy ${signal.longStrike} │ ~$${signal.estimatedCredit.toFixed(2)} credit │ ${signal.reason}`));

    // Position size: how many spreads can we afford?
    const maxRisk = config.spreadWidth * 100; // $1 spread = $100 max risk per contract
    const quantity = Math.max(1, Math.floor(config.positionSizeUSD / maxRisk));

    try {
      const result = await placeCreditSpread({
        type: signal.type,
        shortStrike: signal.shortStrike,
        longStrike: signal.longStrike,
        expiration: expirationDate,
        quantity,
        creditLimit: signal.estimatedCredit,
      });

      const trade = {
        id: `${signal.side}-${signal.shortStrike}-${Date.now()}`,
        side: signal.side,
        type: signal.type,
        shortStrike: signal.shortStrike,
        longStrike: signal.longStrike,
        expiration: expirationDate,
        quantity,
        creditReceived: signal.estimatedCredit,
        entryTime: new Date().toISOString(),
        status: 'open',
        reason: signal.reason,
      };
      trades.push(trade);
      saveTrades();

      const riskStr = `$${(quantity * maxRisk).toFixed(0)} risk`;
      const creditStr = `$${(signal.estimatedCredit * quantity * 100).toFixed(0)} credit`;
      console.log(chalk.green(`  [entry] ${signal.side} x${quantity} │ ${creditStr} │ ${riskStr}`));
      if (result.dryRun) console.log(chalk.gray('    (dry run)'));
    } catch (err) {
      console.log(chalk.red(`  [entry] Order error: ${err.message}`));
    }
  }

  // ── Stage 7: Summary ──
  const closedToday = trades.filter(t => t.status === 'closed' && t.closeTime?.startsWith(getETTime().dateStr));
  const totalPnl = closedToday.reduce((s, t) => s + (t.pnl || 0), 0);
  const stillOpen = getOpenTrades().length;
  const wins = closedToday.filter(t => (t.pnl || 0) > 0).length;
  const losses = closedToday.filter(t => (t.pnl || 0) < 0).length;

  if (closedToday.length || stillOpen) {
    const pnlStr = totalPnl >= 0
      ? chalk.green(`+$${totalPnl.toFixed(2)}`)
      : chalk.red(`-$${Math.abs(totalPnl).toFixed(2)}`);
    console.log(chalk.white(`  [summary] Open: ${stillOpen} │ Closed today: ${closedToday.length} (${wins}W/${losses}L) │ PnL: ${pnlStr}`));
  }
}

// ── Helpers ──────────────────────────────────────────────────

function extractSpotPrice(chain, balance) {
  // Try to get from chain's underlying price
  if (chain && chain.length) {
    for (const exp of chain) {
      if (exp['underlying-price']) return parseFloat(exp['underlying-price']);
    }
  }
  // Fallback: try from balance
  if (balance && balance['underlying-price']) return parseFloat(balance['underlying-price']);
  return null;
}

/**
 * Rough estimate of current spread value based on distance from spot
 * In production, replace with real-time option quotes
 */
function estimateSpreadValue(trade, spotPrice, currentExpiration) {
  const { shortStrike, type, creditReceived } = trade;
  const distFromSpot = type === 'put'
    ? (spotPrice - shortStrike) / spotPrice
    : (shortStrike - spotPrice) / spotPrice;

  if (distFromSpot < 0) {
    // ITM — spread is near max value
    return config.spreadWidth * 0.9;
  }

  // OTM — decaying toward 0
  // Rough model: value decays as it moves OTM and time passes
  const timeDecay = getTimeDecayFactor();
  const distanceFactor = Math.max(0, 1 - distFromSpot * 50);
  return Math.max(0.01, creditReceived * distanceFactor * timeDecay);
}

function getTimeDecayFactor() {
  const { hour, minute } = getETTime();
  const minutesToClose = (16 - hour) * 60 - minute;
  const totalMinutes = 6.5 * 60; // market hours
  return Math.max(0.1, minutesToClose / totalMinutes);
}

// ── Boot ────────────────────────────────────────────────────

export async function startBot() {
  console.log(chalk.bold.cyan('\n  ╔═══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║   0DTE Credit Spread Bot v1.0        ║'));
  console.log(chalk.bold.cyan('  ║   SPY │ Tastytrade                   ║'));
  console.log(chalk.bold.cyan('  ╚═══════════════════════════════════════╝\n'));

  console.log(chalk.white(`  Mode: ${config.dryRun ? chalk.yellow('DRY RUN') : chalk.red('LIVE TRADING')}`));
  console.log(chalk.white(`  Sandbox: ${config.sandbox ? 'yes' : chalk.red('NO — REAL MONEY')}`));
  console.log(chalk.white(`  Symbol: ${config.symbol}`));
  console.log(chalk.white(`  Spread width: $${config.spreadWidth}`));
  console.log(chalk.white(`  Target delta: ~${config.targetDelta}`));
  console.log(chalk.white(`  Position size: $${config.positionSizeUSD}`));
  console.log(chalk.white(`  Max positions: ${config.maxOpenPositions}`));
  console.log(chalk.white(`  Profit target: ${config.profitTargetPct}%`));
  console.log(chalk.white(`  Stop loss: ${config.stopLossMultiplier}x credit`));
  console.log(chalk.white(`  Entry after: ${config.entryAfterMinutes}min from open`));
  console.log(chalk.white(`  Poll interval: ${config.pollIntervalSeconds}s\n`));

  // Load trade history
  loadTrades();
  const openCount = getOpenTrades().length;
  const totalCount = trades.length;
  console.log(chalk.gray(`  Loaded ${totalCount} trades (${openCount} open)\n`));

  // Authenticate
  try {
    await login();
    await getAccount();
    const bal = await getBalance();
    const cash = parseFloat(bal['cash-balance'] || bal['net-liquidating-value'] || 0);
    console.log(chalk.green(`  Starting balance: $${cash.toFixed(2)}\n`));
    sessionRefreshTime = Date.now();
  } catch (err) {
    console.log(chalk.red(`\n  Authentication failed: ${err.message}`));
    console.log(chalk.yellow('  Check your TT_USERNAME and TT_PASSWORD in .env'));
    process.exit(1);
  }

  // Main loop
  console.log(chalk.green('  Bot started. Polling...\n'));
  while (true) {
    try {
      await pollCycle();
    } catch (err) {
      console.log(chalk.red(`  [error] Cycle failed: ${err.message}`));
    }
    await new Promise(r => setTimeout(r, config.pollIntervalSeconds * 1000));
  }
}
