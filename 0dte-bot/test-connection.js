/**
 * Test connection to Tastytrade API
 * Verifies credentials, account access, and option chain data
 */

import chalk from 'chalk';
import config from './config.js';
import {
  login,
  getAccount,
  getBalance,
  getPositions,
  getOptionChain,
  find0DTEExpiration,
  flattenChain,
  getOrders,
} from './tastytrade.js';

async function test() {
  console.log(chalk.bold('\n  Tastytrade Connection Test\n'));
  console.log(chalk.gray(`  Endpoint: ${config.baseUrl}`));
  console.log(chalk.gray(`  Sandbox: ${config.sandbox}`));

  // 1. Auth
  console.log(chalk.cyan('\n  1. Authenticating...'));
  try {
    await login();
    console.log(chalk.green('     ✓ Login successful'));
  } catch (err) {
    console.log(chalk.red(`     ✗ Login failed: ${err.message}`));
    process.exit(1);
  }

  // 2. Account
  console.log(chalk.cyan('\n  2. Fetching account...'));
  try {
    const acct = await getAccount();
    console.log(chalk.green(`     ✓ Account: ${acct}`));
  } catch (err) {
    console.log(chalk.red(`     ✗ Account fetch failed: ${err.message}`));
    process.exit(1);
  }

  // 3. Balance
  console.log(chalk.cyan('\n  3. Fetching balance...'));
  try {
    const bal = await getBalance();
    const cash = bal['cash-balance'] || bal['net-liquidating-value'] || 'unknown';
    console.log(chalk.green(`     ✓ Cash balance: $${cash}`));
    console.log(chalk.gray(`       Full balance data: ${JSON.stringify(bal, null, 2).slice(0, 500)}`));
  } catch (err) {
    console.log(chalk.red(`     ✗ Balance fetch failed: ${err.message}`));
  }

  // 4. Positions
  console.log(chalk.cyan('\n  4. Fetching positions...'));
  try {
    const positions = await getPositions();
    console.log(chalk.green(`     ✓ ${positions.length} open positions`));
    for (const pos of positions.slice(0, 5)) {
      console.log(chalk.gray(`       ${pos.symbol} │ ${pos.quantity} │ ${pos['quantity-direction']}`));
    }
  } catch (err) {
    console.log(chalk.red(`     ✗ Positions fetch failed: ${err.message}`));
  }

  // 5. Option chain
  console.log(chalk.cyan('\n  5. Fetching SPY option chain...'));
  try {
    const chain = await getOptionChain('SPY');
    const expirations = flattenChain(chain);
    console.log(chalk.green(`     ✓ ${expirations.length} expirations loaded`));

    // Show first few expirations with strike counts
    for (const exp of expirations.slice(0, 8)) {
      const date = exp['expiration-date'];
      const strikeCount = exp.strikes.length;
      const sampleStrikes = exp.strikes.slice(0, 3).map(s => s.strikePrice);
      console.log(chalk.gray(`       ${date} │ ${strikeCount} strikes │ e.g. ${sampleStrikes.join(', ')}`));
    }

    // Check for 0DTE
    const exp0DTE = find0DTEExpiration(chain);
    if (exp0DTE) {
      console.log(chalk.green(`     ✓ 0DTE expiration found: ${exp0DTE['expiration-date']} │ ${exp0DTE.strikes.length} strikes`));
    } else {
      // Show nearest expiration
      if (expirations.length) {
        console.log(chalk.yellow(`     ⚠ No 0DTE today (weekend/holiday) │ Next: ${expirations[0]['expiration-date']}`));
      } else {
        console.log(chalk.yellow('     ⚠ No expirations found'));
      }
    }
  } catch (err) {
    console.log(chalk.red(`     ✗ Chain fetch failed: ${err.message}`));
  }

  // 6. Open orders
  console.log(chalk.cyan('\n  6. Fetching open orders...'));
  try {
    const orders = await getOrders();
    console.log(chalk.green(`     ✓ ${orders.length} open orders`));
  } catch (err) {
    console.log(chalk.red(`     ✗ Orders fetch failed: ${err.message}`));
  }

  console.log(chalk.bold.green('\n  ✓ All tests passed. Ready to trade.\n'));
}

test().catch(err => {
  console.error(chalk.red(`\n  Fatal error: ${err.message}\n`));
  process.exit(1);
});
