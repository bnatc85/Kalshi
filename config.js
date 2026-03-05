import 'dotenv/config';

export const config = {
  // Credentials
  kalshi: {
    apiKey: process.env.KALSHI_API_KEY,
    privateKey: process.env.KALSHI_PRIVATE_KEY,
  },
  polymarket: {
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || null,
    proxyAddress: process.env.POLYMARKET_PROXY_ADDRESS || null,
  },

  // Bot behavior
  dryRun: process.env.DRY_RUN !== 'false',
  minSpreadBps: parseInt(process.env.MIN_SPREAD_BPS || '150'),
  minIRR: parseInt(process.env.MIN_IRR || '20'),
  positionSizeUSD: parseInt(process.env.POSITION_SIZE_USD || '100'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '3'),
  pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '30'),

  // Markets to watch — add/remove slugs here
  // Format: { kalshiSlug, polySlug, label, daysToExpiry }
  markets: [
    {
      label: 'Fed Rate Cut (Jun)',
      kalshiSlug: 'KXFEDRATE-25JUN',
      polySlug: 'will-the-fed-cut-rates-in-june-2025',
    },
    {
      label: 'Fed Rate Cut (Sep)',
      kalshiSlug: 'KXFEDRATE-25SEP',
      polySlug: 'will-the-fed-cut-rates-in-september-2025',
    },
    {
      label: 'Fed Chair Nominee',
      kalshiSlug: 'KXFEDCHAIRNOM',
      polySlug: 'who-will-trump-nominate-as-fed-chair',
    },
  ],
};

// Validate at startup
export function validateConfig() {
  if (!config.kalshi.apiKey || config.kalshi.apiKey === 'your_api_key_id_here') {
    throw new Error('Missing KALSHI_API_KEY in .env — copy .env.example to .env and fill it in.');
  }
  if (!config.kalshi.privateKey || config.kalshi.privateKey.includes('PASTE_YOUR_KEY_HERE')) {
    throw new Error('Missing KALSHI_PRIVATE_KEY in .env');
  }
  console.log('[config] ✓ Credentials present');
  console.log(`[config] Mode: ${config.dryRun ? '🟡 DRY RUN' : '🔴 LIVE TRADING'}`);
  console.log(`[config] Min spread: ${config.minSpreadBps}bps | Min IRR: ${config.minIRR}% | Size: $${config.positionSizeUSD}`);
}
