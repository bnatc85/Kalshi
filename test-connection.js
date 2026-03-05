/**
 * Verify Kalshi credentials and Polymarket public API access.
 * Run: npm run test-connection
 */

import pmxt from 'pmxtjs';
import { config, validateConfig } from './config.js';

async function main() {
  console.log('\n=== Signal BonBon Connection Test ===\n');

  validateConfig();

  // Kalshi
  console.log('\n[kalshi] Connecting...');
  const kalshi = new pmxt.Kalshi({
    apiKey: config.kalshi.apiKey,
    privateKey: config.kalshi.privateKey,
  });

  const balance = await kalshi.fetchBalance();
  console.log(`[kalshi] Connected. Balance: $${balance[0]?.available?.toFixed(2) ?? 'N/A'}`);

  console.log('\n[kalshi] Fetching configured markets:');
  for (const m of config.markets) {
    try {
      const markets = await kalshi.fetchMarkets({ ticker: m.kalshiTicker, limit: 1 });
      if (!markets.length) {
        console.log(`  [!] ${m.label}: No market found for "${m.kalshiTicker}"`);
        continue;
      }
      const market = markets[0];
      const yes = market.yes?.price ?? market.outcomes?.[0]?.price ?? '?';
      const no  = market.no?.price  ?? market.outcomes?.[1]?.price ?? '?';
      console.log(`  [ok] ${m.label}: YES=${(yes * 100).toFixed(1)}c  NO=${(no * 100).toFixed(1)}c`);
    } catch (e) {
      console.log(`  [!!] ${m.label}: ${e.message}`);
    }
  }

  // Polymarket (public gamma API)
  console.log('\n[polymarket] Fetching public prices (gamma API)...');
  for (const m of config.markets) {
    if (!m.polySlug) continue;
    try {
      const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(m.polySlug)}&limit=1`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (!data.length) {
        console.log(`  [!] ${m.label}: No market found for slug "${m.polySlug}"`);
        continue;
      }
      const prices = JSON.parse(data[0].outcomePrices || '[]');
      console.log(`  [ok] ${m.label}: YES=${(parseFloat(prices[0]) * 100).toFixed(1)}c  NO=${(parseFloat(prices[1]) * 100).toFixed(1)}c`);
      console.log(`       "${data[0].question}"`);
    } catch (e) {
      console.log(`  [!!] ${m.label}: ${e.message}`);
    }
  }

  console.log('\n=== Test complete. If both show [ok], run: npm run scan ===\n');
}

main().catch(err => {
  console.error('\n[error]', err.message);
  process.exit(1);
});
