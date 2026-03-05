/**
 * Run this FIRST before starting the bot:
 *   npm run test-connection
 *
 * Verifies your Kalshi (and optionally Polymarket) credentials work,
 * prints your balance, and fetches live prices for your configured markets.
 */

import pmxt from 'pmxtjs';
import { config, validateConfig } from './config.js';

async function main() {
  console.log('\n=== SynthArb Connection Test ===\n');

  validateConfig();

  // ── Kalshi ──────────────────────────────────────────────────────────────────
  console.log('\n[kalshi] Connecting...');
  const kalshi = new pmxt.Kalshi({
    apiKey: config.kalshi.apiKey,
    privateKey: config.kalshi.privateKey,
  });

  const balance = await kalshi.fetchBalance();
  console.log(`[kalshi] ✓ Connected. Balance: $${balance[0]?.available?.toFixed(2) ?? 'N/A'}`);

  console.log('\n[kalshi] Fetching configured markets:');
  for (const m of config.markets) {
    try {
      const markets = await kalshi.fetchMarkets({ slug: m.kalshiSlug, limit: 1 });
      if (!markets.length) {
        console.log(`  ⚠  ${m.label}: No market found for slug "${m.kalshiSlug}"`);
        continue;
      }
      const market = markets[0];
      const yes = market.outcomes.find(o => o.label === 'Yes')?.price ?? '?';
      const no  = market.outcomes.find(o => o.label === 'No')?.price  ?? '?';
      console.log(`  ✓  ${m.label}: YES=${(yes * 100).toFixed(1)}¢  NO=${(no * 100).toFixed(1)}¢`);
    } catch (e) {
      console.log(`  ✗  ${m.label}: ${e.message}`);
    }
  }

  // ── Polymarket (optional) ──────────────────────────────────────────────────
  if (config.polymarket.privateKey) {
    console.log('\n[polymarket] Connecting...');
    try {
      const poly = new pmxt.Polymarket({
        privateKey: config.polymarket.privateKey,
        funderAddress: config.polymarket.proxyAddress,
      });
      const polyBalance = await poly.fetchBalance();
      console.log(`[polymarket] ✓ Connected. Balance: $${polyBalance[0]?.available?.toFixed(2) ?? 'N/A'}`);

      console.log('\n[polymarket] Fetching configured markets:');
      for (const m of config.markets) {
        if (!m.polySlug) continue;
        try {
          const markets = await poly.fetchMarkets({ slug: m.polySlug, limit: 1 });
          if (!markets.length) {
            console.log(`  ⚠  ${m.label}: No market found for slug "${m.polySlug}"`);
            continue;
          }
          const market = markets[0];
          const yes = market.outcomes.find(o => o.label === 'Yes')?.price ?? '?';
          const no  = market.outcomes.find(o => o.label === 'No')?.price  ?? '?';
          console.log(`  ✓  ${m.label}: YES=${(yes * 100).toFixed(1)}¢  NO=${(no * 100).toFixed(1)}¢`);
        } catch (e) {
          console.log(`  ✗  ${m.label}: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`[polymarket] ✗ Connection failed: ${e.message}`);
    }
  } else {
    console.log('\n[polymarket] Skipped (no POLYMARKET_PRIVATE_KEY set — Kalshi-only mode)');
  }

  console.log('\n=== Test complete. If all ✓, run: npm run dry ===\n');
}

main().catch(err => {
  console.error('\n[error]', err.message);
  process.exit(1);
});
