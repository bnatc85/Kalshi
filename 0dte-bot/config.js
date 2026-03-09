import 'dotenv/config';

const sandbox = process.env.TT_SANDBOX !== 'false';

export default {
  // Tastytrade API
  baseUrl: sandbox
    ? 'https://api.cert.tastyworks.com'
    : 'https://api.tastyworks.com',
  sandbox,
  username: process.env.TT_USERNAME,
  password: process.env.TT_PASSWORD,

  // Bot behavior
  dryRun: process.env.DRY_RUN !== 'false',
  pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '30'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '3'),
  positionSizeUSD: parseInt(process.env.POSITION_SIZE_USD || '50'),

  // 0DTE Credit Spread strategy
  symbol: 'SPY',
  targetDelta: parseInt(process.env.TARGET_DELTA || '10'),    // ~10 delta short strikes
  spreadWidth: parseInt(process.env.SPREAD_WIDTH || '1'),      // $1 wide spreads
  profitTargetPct: parseInt(process.env.PROFIT_TARGET_PCT || '50'),  // close at 50% profit
  stopLossMultiplier: parseInt(process.env.STOP_LOSS_MULTIPLIER || '2'),  // close at 2x credit received
  entryAfterMinutes: parseInt(process.env.ENTRY_AFTER_MINUTES || '60'),   // wait 60min after open
  exitBeforeMinutes: 15,  // close all positions 15min before close (3:45 PM ET)

  // Market hours (Eastern Time)
  marketOpenHour: 9,
  marketOpenMinute: 30,
  marketCloseHour: 16,
  marketCloseMinute: 0,
};
