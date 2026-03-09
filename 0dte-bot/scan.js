/**
 * One-shot scanner — show current 0DTE opportunities without trading
 */

import chalk from 'chalk';
import config from './config.js';
import {
  login,
  getAccount,
  getBalance,
  getOptionChain,
  find0DTEExpiration,
} from './tastytrade.js';
import { selectStrikes } from './signals.js';

async function scan() {
  console.log(chalk.bold('\n  0DTE Scanner\n'));

  await login();
  await getAccount();
  const bal = await getBalance();
  const chain = await getOptionChain(config.symbol);

  const exp0DTE = find0DTEExpiration(chain);
  if (!exp0DTE) {
    console.log(chalk.yellow('  No 0DTE expiration today'));
    process.exit(0);
  }

  console.log(chalk.cyan(`  Expiration: ${exp0DTE['expiration-date']}`));

  // Extract strikes
  const strikes = exp0DTE['strike-prices'] || exp0DTE.strikes || [];
  const strikeValues = strikes.map(s =>
    typeof s === 'number' ? s : parseFloat(s['strike-price'] || s.strike || s)
  ).filter(s => !isNaN(s)).sort((a, b) => a - b);

  if (!strikeValues.length) {
    console.log(chalk.yellow('  No strikes found in chain'));
    process.exit(0);
  }

  // Estimate spot from midpoint of chain
  const midStrike = strikeValues[Math.floor(strikeValues.length / 2)];
  console.log(chalk.cyan(`  ~${strikeValues.length} strikes │ Range: $${strikeValues[0]} - $${strikeValues[strikeValues.length - 1]}`));
  console.log(chalk.cyan(`  Mid strike (≈spot): $${midStrike}\n`));

  // Show potential spreads at various deltas
  console.log(chalk.bold('  PUT CREDIT SPREADS (bullish):'));
  for (const delta of [5, 10, 16, 20]) {
    const spread = selectStrikes(strikeValues, midStrike, 'put', delta, config.spreadWidth);
    if (spread.shortStrike && spread.longStrike) {
      console.log(chalk.white(`    ~${delta}Δ │ Sell ${spread.shortStrike}P / Buy ${spread.longStrike}P │ ~$${spread.estimatedCredit.toFixed(2)} credit`));
    }
  }

  console.log(chalk.bold('\n  CALL CREDIT SPREADS (bearish):'));
  for (const delta of [5, 10, 16, 20]) {
    const spread = selectStrikes(strikeValues, midStrike, 'call', delta, config.spreadWidth);
    if (spread.shortStrike && spread.longStrike) {
      console.log(chalk.white(`    ~${delta}Δ │ Sell ${spread.shortStrike}C / Buy ${spread.longStrike}C │ ~$${spread.estimatedCredit.toFixed(2)} credit`));
    }
  }

  const cash = parseFloat(bal['cash-balance'] || bal['net-liquidating-value'] || 0);
  const maxSpreads = Math.floor(cash / (config.spreadWidth * 100));
  console.log(chalk.cyan(`\n  Cash: $${cash.toFixed(2)} │ Max $${config.spreadWidth} spreads: ${maxSpreads}\n`));
}

scan().catch(err => {
  console.error(chalk.red(`  Error: ${err.message}`));
  process.exit(1);
});
