import 'dotenv/config';

export const config = {
  // Credentials — Kalshi only (Polymarket is read-only public data)
  kalshi: {
    apiKey: process.env.KALSHI_API_KEY,
    privateKey: process.env.KALSHI_PRIVATE_KEY,
  },

  // Bot behavior
  dryRun: process.env.DRY_RUN !== 'false',
  minDivergenceBps: parseInt(process.env.MIN_DIVERGENCE_BPS || '300'),
  minIRR: parseInt(process.env.MIN_IRR || '20'),
  positionSizeUSD: parseInt(process.env.POSITION_SIZE_USD || '100'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '3'),
  pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '60'),
  exitConvergenceBps: parseInt(process.env.EXIT_CONVERGENCE_BPS || '50'),

  // Markets to watch
  // polySlug: the slug from Polymarket's gamma API
  // compareMode: how to align the two prices
  //   'direct' — both YES measure the same thing
  //   'kalshi-no-vs-poly-yes' — Kalshi NO = Poly YES (inverted framing)
  markets: [
    {
      label: 'Fed Mar - Rate Cut (25bp)',
      kalshiTicker: 'KXFED-26MAR-T4.25',
      polySlug: 'will-the-fed-decrease-interest-rates-by-25-bps-after-the-march-2026-meeting',
      // Kalshi YES = rate below 4.25 (cut of 25bp+)
      // Poly YES = Fed decreases by exactly 25bp
      compareMode: 'direct',
      expiryDate: '2026-03-19',  // FOMC March 2026 meeting
    },
    {
      label: 'Fed Mar - No Change',
      kalshiTicker: 'KXFED-26MAR-T4.50',
      polySlug: 'will-there-be-no-change-in-fed-interest-rates-after-the-march-2026-meeting',
      // Kalshi NO on T4.50 = rate stays >= 4.50 = no cut
      // Poly YES = no change in rates
      compareMode: 'kalshi-no-vs-poly-yes',
      expiryDate: '2026-03-19',  // FOMC March 2026 meeting
    },
    {
      label: 'Iran Leader - Mojtaba Khamenei',
      kalshiTicker: 'KXNEXTIRANLEADER-45JAN01-MKHA',
      polySlug: 'will-mojtaba-khamenei-be-the-next-supreme-leader-of-iran-573',
      compareMode: 'direct',
    },
    {
      label: 'Greenland Acquisition',
      kalshiTicker: 'KXGREENLANDPRICE-29JAN21-NOACQ',
      polySlug: 'will-trump-acquire-greenland-before-2027',
      // Both YES = acquisition happens (Kalshi YES = no acquisition, needs invert)
      compareMode: 'kalshi-no-vs-poly-yes',
    },
    {
      label: 'Fed Jun - Rate Cut (25bp)',
      kalshiTicker: 'KXFED-26JUN-T4.25',
      polySlug: 'will-the-fed-decrease-interest-rates-by-25-bps-after-the-june-2026-meeting',
      compareMode: 'direct',
      expiryDate: '2026-06-18',
    },
    {
      label: 'Fed Jun - No Change',
      kalshiTicker: 'KXFED-26JUN-T4.50',
      polySlug: 'will-there-be-no-change-in-fed-interest-rates-after-the-june-2026-meeting',
      compareMode: 'kalshi-no-vs-poly-yes',
      expiryDate: '2026-06-18',
    },
    {
      label: 'Israel PM - Naftali Bennett',
      kalshiTicker: 'KXNEXTISRAELPM-45JAN01-NBEN',
      polySlug: 'will-naftali-bennett-be-the-next-prime-minister-of-israel',
      compareMode: 'direct',
    },
    {
      label: 'Israel PM - Yair Golan',
      kalshiTicker: 'KXNEXTISRAELPM-45JAN01-YGOL',
      polySlug: 'will-yair-golan-be-the-next-prime-minister-of-israel',
      compareMode: 'direct',
    },
    {
      label: 'Israel PM - Benny Gantz',
      kalshiTicker: 'KXNEXTISRAELPM-45JAN01-BGAN',
      polySlug: 'will-benny-gantz-be-the-next-prime-minister-of-israel',
      compareMode: 'direct',
    },
  ],
};

export function validateConfig() {
  if (!config.kalshi.apiKey || config.kalshi.apiKey === 'your_api_key_id_here') {
    throw new Error('Missing KALSHI_API_KEY in .env');
  }
  if (!config.kalshi.privateKey || config.kalshi.privateKey.includes('PASTE_YOUR_KEY_HERE')) {
    throw new Error('Missing KALSHI_PRIVATE_KEY in .env');
  }
  console.log('[config] Credentials present');
  console.log(`[config] Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE TRADING'}`);
  console.log(`[config] Min divergence: ${config.minDivergenceBps}bps | Min IRR: ${config.minIRR}% | Size: $${config.positionSizeUSD}`);
}
