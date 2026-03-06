/**
 * Web dashboard for Signal BonBon — Kalshi-Only Bot.
 * Shows live market divergences, order book depth, and trade history.
 *
 * Run: npm run dashboard
 */

import fs from 'fs';
import express from 'express';
import { validateConfig, config, loadApprovedMarkets } from './config.js';
import { initClients, fetchMarketPrices } from './fetcher.js';
import { findDivergence } from './arbitrage.js';
import { runDiscovery, loadCandidates, approveCandidate, dismissCandidate } from './discovery.js';
import { getKalshiClient } from './fetcher.js';

validateConfig();
loadApprovedMarkets();
initClients();

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// State
let lastScan = null;
let scanHistory = [];
let botStatus = 'idle';
let lastScanTime = null;

async function runScan() {
  botStatus = 'scanning';
  try {
    // Fetch sequentially to avoid Kalshi API rate limits (429)
    const snapshots = [];
    for (const market of config.markets) {
      snapshots.push(await fetchMarketPrices(market));
      await new Promise(r => setTimeout(r, 1000));
    }
    const results = [];

    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];
      const market = config.markets[i];

      if (snap.kalshiPrice === null || snap.polyPrice === null) {
        results.push({
          label: market.label,
          error: `Missing prices (K=${snap.kalshiPrice} P=${snap.polyPrice})`,
        });
        continue;
      }

      const sig = findDivergence(snap.polyPrice, snap.kalshiPrice, snap.kalshiSide, snap.daysToExpiry);
      const meets = sig.divergenceBps >= config.minDivergenceBps && sig.irr >= config.minIRR;

      // Order book summary
      const ob = snap.orderBook;
      let orderBook = null;
      if (ob) {
        const tradeSide = sig.tradeSide;
        const fillAtBest = tradeSide === 'yes'
          ? ob.fillable.yesBuy
          : ob.fillable.noBuy;
        const totalDepth = tradeSide === 'yes'
          ? ob.fillable.yesBuyDepth
          : ob.fillable.noBuyDepth;

        orderBook = {
          yesBid: ob.spread.yesBid,
          yesAsk: ob.spread.yesAsk,
          noBid: ob.spread.noBid,
          noAsk: ob.spread.noAsk,
          yesBidAskSpread: ob.spread.yesBidAskSpread,
          noBidAskSpread: ob.spread.noBidAskSpread,
          fillAtBest,
          totalDepth,
          tradeSideDepth: tradeSide === 'yes' ? ob.yesAsks : ob.noAsks,
          oppositeSideDepth: tradeSide === 'yes' ? ob.yesBids : ob.noBids,
          yesBids: ob.yesBids.slice(0, 8),
          yesAsks: ob.yesAsks.slice(0, 8),
          noBids: ob.noBids.slice(0, 8),
          noAsks: ob.noAsks.slice(0, 8),
        };
      }

      // Build recommendation string
      const contracts = Math.floor(config.positionSizeUSD / sig.entryPrice);
      const profitUsd = (sig.expectedProfit * contracts).toFixed(2);
      let recommendation = null;
      if (meets) {
        const fillOk = !ob || ob.fillAtBest >= contracts;
        const liqWarn = !fillOk ? ' (LOW LIQUIDITY - check order book)' : '';
        recommendation = `Recommend: BUY ${sig.tradeSide.toUpperCase()} "${market.label}" on Kalshi @ ${(sig.entryPrice * 100).toFixed(1)}c × ${contracts} contracts ($${config.positionSizeUSD}) → expected profit $${profitUsd} (${sig.irr.toFixed(0)}% IRR)${liqWarn}`;
      } else if (sig.divergenceBps >= config.minDivergenceBps * 0.7) {
        recommendation = `Watch: "${market.label}" approaching signal threshold (${sig.divergenceBps.toFixed(0)}bps / ${sig.irr.toFixed(0)}% IRR)`;
      }

      results.push({
        label: market.label,
        kalshiTicker: market.kalshiTicker,
        kalshiYes: snap.kalshiYes,
        kalshiNo: snap.kalshiNo,
        kalshiYesLast: snap.kalshiYesLast,
        kalshiNoLast: snap.kalshiNoLast,
        kalshiPrice: snap.kalshiPrice,
        polyPrice: snap.polyPrice,
        divergenceBps: sig.divergenceBps,
        irr: sig.irr,
        tradeSide: sig.tradeSide,
        entryPrice: sig.entryPrice,
        daysToExpiry: snap.daysToExpiry,
        meetsThreshold: meets,
        expectedProfit: sig.expectedProfit,
        recommendation,
        orderBook,
      });
    }

    lastScan = results;
    lastScanTime = new Date().toISOString();
    scanHistory.unshift({ time: lastScanTime, results: results.map(r => ({...r, orderBook: undefined})) });
    if (scanHistory.length > 100) scanHistory.length = 100;
    botStatus = 'ready';
  } catch (e) {
    botStatus = 'error: ' + e.message;
  }
}

// API endpoints
app.get('/api/scan', async (req, res) => {
  await runScan();
  res.json({ status: botStatus, time: lastScanTime, markets: lastScan, config: getPublicConfig() });
});

app.get('/api/status', (req, res) => {
  res.json({ status: botStatus, time: lastScanTime, markets: lastScan, config: getPublicConfig() });
});

app.get('/api/history', (req, res) => {
  res.json(scanHistory.slice(0, 50));
});

// Discovery endpoints
app.use(express.json());

app.get('/api/discover', async (req, res) => {
  try {
    const result = await runDiscovery();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/candidates', (req, res) => {
  res.json(loadCandidates());
});

app.post('/api/candidates/approve', (req, res) => {
  const result = approveCandidate(req.body.id);
  res.json(result);
});

app.post('/api/candidates/dismiss', (req, res) => {
  const result = dismissCandidate(req.body.id);
  res.json(result);
});

// Trades ledger endpoint
app.get('/api/trades', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync('./trades.json', 'utf8'));
    res.json(data);
  } catch {
    res.json([]);
  }
});

// Positions endpoints
app.get('/api/positions', async (req, res) => {
  try {
    const positions = await getKalshiClient().fetchPositions();
    // Merge with trade ledger for entry prices
    let trades = [];
    try { trades = JSON.parse(fs.readFileSync('./trades.json', 'utf8')); } catch {}
    const tradeMap = new Map(trades.filter(t => t.status === 'open').map(t => [t.ticker, t]));

    const enriched = positions.map(p => {
      const saved = tradeMap.get(p.marketId);
      return {
        ...p,
        entryPrice: p.entryPrice || saved?.entryPrice || null,
        savedSide: saved?.side || null,
        savedContracts: saved?.contracts || null,
      };
    });
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/balance', async (req, res) => {
  try {
    const balance = await getKalshiClient().fetchBalance();
    res.json(balance);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getPublicConfig() {
  return {
    dryRun: config.dryRun,
    minDivergenceBps: config.minDivergenceBps,
    minIRR: config.minIRR,
    positionSizeUSD: config.positionSizeUSD,
    pollIntervalSeconds: config.pollIntervalSeconds,
    marketCount: config.markets.length,
  };
}

app.get('/', (req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Signal BonBon Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; background: #0a0e17; color: #c9d1d9; min-height: 100vh; }

  .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 18px; color: #58a6ff; font-weight: 600; }
  .header .mode { padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .mode-dry { background: #3d2e00; color: #f0c000; border: 1px solid #f0c000; }
  .mode-live { background: #2d0000; color: #ff4444; border: 1px solid #ff4444; }

  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }

  .status-bar { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .status-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px 20px; flex: 1; min-width: 130px; }
  .status-card .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .status-card .value { font-size: 22px; font-weight: 700; color: #e6edf3; }
  .status-card .value.green { color: #3fb950; }
  .status-card .value.yellow { color: #f0c000; }

  .controls { display: flex; gap: 12px; margin-bottom: 24px; align-items: center; }
  .btn { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 18px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 13px; transition: all 0.15s; }
  .btn:hover { background: #30363d; border-color: #58a6ff; }
  .btn:active { transform: scale(0.97); }
  .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .btn.primary:hover { background: #388bfd; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .auto-label { font-size: 12px; color: #8b949e; }
  #lastUpdate { font-size: 12px; color: #8b949e; margin-left: auto; }

  .section { margin-bottom: 28px; }
  .section h2 { font-size: 14px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #21262d; }

  .market-grid { display: grid; gap: 16px; }
  .market-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 18px; transition: border-color 0.2s; }
  .market-card.signal { border-color: #3fb950; box-shadow: 0 0 12px rgba(63, 185, 80, 0.1); }
  .market-card .title { font-size: 15px; font-weight: 600; color: #e6edf3; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 700; }
  .badge-signal { background: #0d3320; color: #3fb950; }
  .badge-quiet { background: #21262d; color: #8b949e; }
  .badge-warn { background: #3d2200; color: #f0c000; }
  .badge-danger { background: #3d0000; color: #ff6b6b; }
  .badge-buy { background: #0d3320; color: #3fb950; border: 1px solid #3fb950; }
  .badge-wait { background: #3d2e00; color: #f0c000; border: 1px solid #f0c000; }
  .badge-pass { background: #21262d; color: #484f58; border: 1px solid #30363d; }

  .price-row { display: flex; gap: 24px; margin-bottom: 10px; flex-wrap: wrap; }
  .price-item .pl { font-size: 11px; color: #8b949e; margin-bottom: 2px; }
  .price-item .pv { font-size: 18px; font-weight: 700; }
  .price-item .pv.stale { color: #8b949e; text-decoration: line-through; font-size: 14px; }

  .metrics-row { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 8px; padding-top: 10px; border-top: 1px solid #21262d; }
  .metric { font-size: 12px; }
  .metric .ml { color: #8b949e; }
  .metric .mv { font-weight: 600; }
  .mv.high { color: #3fb950; }
  .mv.med { color: #f0c000; }
  .mv.low { color: #8b949e; }

  .trade-signal { margin-top: 10px; padding: 10px 14px; background: #0d1117; border-radius: 6px; border: 1px solid #21262d; font-size: 13px; }
  .trade-signal .action { color: #3fb950; font-weight: 700; }
  .trade-signal .profit { color: #f0c000; }

  .recommendation { margin-top: 12px; padding: 12px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; }
  .recommendation.buy { background: #0d3320; border: 1px solid #3fb950; color: #3fb950; }
  .recommendation.watch { background: #2d2200; border: 1px solid #f0c000; color: #f0c000; }

  /* Order Book */
  .ob-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid #21262d; }
  .ob-title { font-size: 12px; color: #8b949e; margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .ob-summary { display: flex; gap: 16px; margin-bottom: 12px; flex-wrap: wrap; }
  .ob-stat { background: #0d1117; padding: 8px 12px; border-radius: 6px; border: 1px solid #21262d; font-size: 12px; }
  .ob-stat .os-label { color: #8b949e; font-size: 10px; display: block; margin-bottom: 2px; }
  .ob-stat .os-val { font-weight: 700; font-size: 14px; }
  .ob-stat .os-val.good { color: #3fb950; }
  .ob-stat .os-val.warn { color: #f0c000; }
  .ob-stat .os-val.bad { color: #ff6b6b; }

  .ob-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .ob-side { background: #0d1117; border-radius: 6px; padding: 10px; border: 1px solid #21262d; }
  .ob-side-title { font-size: 11px; font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .ob-side-title.bid { color: #3fb950; }
  .ob-side-title.ask { color: #ff6b6b; }

  .ob-row { display: flex; justify-content: space-between; font-size: 11px; padding: 2px 0; position: relative; }
  .ob-row .ob-price { color: #e6edf3; z-index: 1; }
  .ob-row .ob-size { color: #8b949e; z-index: 1; }
  .ob-bar { position: absolute; top: 0; height: 100%; border-radius: 2px; opacity: 0.15; }
  .ob-bar.bid-bar { right: 0; background: #3fb950; }
  .ob-bar.ask-bar { left: 0; background: #ff6b6b; }

  .liquidity-warn { margin-top: 8px; padding: 8px 12px; background: #2d1600; border: 1px solid #f0c000; border-radius: 6px; font-size: 12px; color: #f0c000; }

  .history-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .history-table th { text-align: left; padding: 8px; color: #8b949e; border-bottom: 1px solid #30363d; font-weight: 600; }
  .history-table td { padding: 8px; border-bottom: 1px solid #21262d; }
  .history-table tr:hover { background: #161b22; }

  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 6px; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { text-align: center; padding: 40px; color: #484f58; font-size: 14px; }
</style>
</head>
<body>

<div class="header">
  <h1>Signal BonBon Dashboard</h1>
  <span class="mode" id="modeLabel">...</span>
</div>

<div class="container">
  <div class="status-bar">
    <div class="status-card"><div class="label">Status</div><div class="value" id="statusValue">--</div></div>
    <div class="status-card"><div class="label">Markets</div><div class="value" id="marketCount">--</div></div>
    <div class="status-card"><div class="label">Signals</div><div class="value" id="signalCount">--</div></div>
    <div class="status-card"><div class="label">Min Divergence</div><div class="value" id="minDiv">--</div></div>
    <div class="status-card"><div class="label">Min IRR</div><div class="value" id="minIRR">--</div></div>
  </div>

  <div class="controls">
    <button class="btn primary" id="scanBtn" onclick="doScan()">Scan Now</button>
    <button class="btn" id="autoBtn" onclick="toggleAuto()">Auto: OFF</button>
    <span class="auto-label" id="autoLabel"></span>
    <span id="lastUpdate"></span>
  </div>

  <div class="section">
    <h2>Open Positions (Kalshi)</h2>
    <div class="controls" style="margin-bottom:12px">
      <button class="btn" onclick="loadPositions()">Refresh Positions</button>
      <span id="balanceDisplay" style="font-size:13px;color:#8b949e;margin-left:12px"></span>
    </div>
    <div id="positionsGrid" class="market-grid">
      <div class="empty">Click "Refresh Positions" to load from Kalshi</div>
    </div>
  </div>

  <div class="section">
    <h2>Market Divergences</h2>
    <div class="market-grid" id="marketGrid">
      <div class="empty">Click "Scan Now" to fetch live prices</div>
    </div>
  </div>

  <div class="section">
    <h2>Market Discovery</h2>
    <div class="controls" style="margin-bottom:12px">
      <button class="btn" id="discoverBtn" onclick="doDiscover()">Discover New Markets</button>
      <button class="btn" onclick="loadCandidates()">Refresh</button>
      <span id="discoverStatus" style="font-size:12px;color:#8b949e"></span>
    </div>
    <div id="candidateGrid" class="market-grid">
      <div class="empty">Click "Discover New Markets" to scan both platforms</div>
    </div>
  </div>

  <div class="section">
    <h2>Scan History</h2>
    <table class="history-table">
      <thead><tr><th>Time</th><th>Market</th><th>K Ask</th><th>K Last</th><th>Poly</th><th>Div (bps)</th><th>IRR</th><th>Signal</th></tr></thead>
      <tbody id="historyBody"></tbody>
    </table>
  </div>
</div>

<script>
let autoInterval = null;
let scanning = false;

async function doScan() {
  if (scanning) return;
  scanning = true;
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Scanning...';
  try {
    const resp = await fetch('/api/scan');
    const data = await resp.json();
    render(data);
    loadHistory();
  } catch (e) {
    document.getElementById('statusValue').textContent = 'Error';
  } finally {
    scanning = false;
    btn.disabled = false;
    btn.textContent = 'Scan Now';
  }
}

function toggleAuto() {
  const btn = document.getElementById('autoBtn');
  const label = document.getElementById('autoLabel');
  if (autoInterval) {
    clearInterval(autoInterval);
    autoInterval = null;
    btn.textContent = 'Auto: OFF';
    label.textContent = '';
  } else {
    autoInterval = setInterval(doScan, 30000);
    btn.textContent = 'Auto: ON';
    label.textContent = 'Refreshing every 30s';
    doScan();
  }
}

function render(data) {
  const ml = document.getElementById('modeLabel');
  ml.textContent = data.config.dryRun ? 'DRY RUN' : 'LIVE';
  ml.className = 'mode ' + (data.config.dryRun ? 'mode-dry' : 'mode-live');

  document.getElementById('statusValue').textContent = data.status;
  document.getElementById('statusValue').className = 'value ' + (data.status === 'ready' ? 'green' : 'yellow');
  document.getElementById('marketCount').textContent = data.config.marketCount;
  document.getElementById('minDiv').textContent = data.config.minDivergenceBps + ' bps';
  document.getElementById('minIRR').textContent = data.config.minIRR + '%';
  document.getElementById('lastUpdate').textContent = 'Last: ' + new Date(data.time).toLocaleTimeString();

  if (!data.markets) return;

  const signals = data.markets.filter(m => m.meetsThreshold);
  document.getElementById('signalCount').textContent = signals.length;
  document.getElementById('signalCount').className = 'value ' + (signals.length > 0 ? 'green' : '');

  const grid = document.getElementById('marketGrid');
  grid.innerHTML = data.markets.map(m => renderMarketCard(m, data.config)).join('');
}

function renderMarketCard(m, cfg) {
  if (m.error) {
    return '<div class="market-card"><div class="title">' + esc(m.label) + ' <span class="badge badge-quiet">ERROR</span></div><div style="color:#8b949e">' + esc(m.error) + '</div></div>';
  }

  const divClass = m.divergenceBps >= 500 ? 'high' : m.divergenceBps >= 200 ? 'med' : 'low';
  const irrClass = m.irr >= 100 ? 'high' : m.irr >= 20 ? 'med' : 'low';
  const contracts = Math.floor(cfg.positionSizeUSD / m.entryPrice);
  const profit = (m.expectedProfit * contracts).toFixed(2);
  const ob = m.orderBook;

  // Determine liquidity quality
  let liqBadge = '';
  if (ob) {
    const fill = ob.fillAtBest;
    if (fill === 0) liqBadge = '<span class="badge badge-danger">NO LIQUIDITY</span>';
    else if (fill < 50) liqBadge = '<span class="badge badge-warn">THIN</span>';
    else if (fill < 500) liqBadge = '<span class="badge badge-quiet">OK</span>';
    else liqBadge = '<span class="badge badge-signal">DEEP</span>';
  }

  // Action badge: BUY / WAIT / PASS
  let actionBadge = '';
  if (m.meetsThreshold) {
    actionBadge = '<span class="badge badge-buy">BUY ' + m.tradeSide.toUpperCase() + '</span>';
  } else if (m.recommendation) {
    actionBadge = '<span class="badge badge-wait">WAIT</span>';
  } else {
    actionBadge = '<span class="badge badge-pass">PASS</span>';
  }

  let html = '<div class="market-card ' + (m.meetsThreshold ? 'signal' : '') + '">' +
    '<div class="title">' + esc(m.label) + ' ' +
      (m.meetsThreshold ? '<span class="badge badge-signal">SIGNAL</span>' : '<span class="badge badge-quiet">WATCHING</span>') +
      ' ' + liqBadge + ' ' + actionBadge +
    '</div>';

  // Prices - show both ask (tradeable) and last traded
  html += '<div class="price-row">' +
    '<div class="price-item"><div class="pl">Kalshi Ask (tradeable)</div><div class="pv">' + fmt(m.kalshiPrice) + '</div></div>' +
    '<div class="price-item"><div class="pl">Kalshi Last</div><div class="pv stale">' + fmt(m.kalshiYesLast, 'yes') + ' / ' + fmt(m.kalshiNoLast, 'no') + '</div></div>' +
    '<div class="price-item"><div class="pl">Polymarket</div><div class="pv">' + fmt(m.polyPrice) + '</div></div>' +
  '</div>';

  // Metrics
  html += '<div class="metrics-row">' +
    '<div class="metric"><span class="ml">Divergence </span><span class="mv ' + divClass + '">' + m.divergenceBps.toFixed(0) + ' bps</span></div>' +
    '<div class="metric"><span class="ml">IRR </span><span class="mv ' + irrClass + '">' + m.irr.toFixed(0) + '%</span></div>' +
    '<div class="metric"><span class="ml">Expiry </span><span class="mv">' + m.daysToExpiry + 'd</span></div>' +
  '</div>';

  // Recommendation
  if (m.recommendation) {
    const recClass = m.meetsThreshold ? 'buy' : 'watch';
    html += '<div class="recommendation ' + recClass + '">' + esc(m.recommendation) + '</div>';
  }

  // Order Book Section
  if (ob) {
    html += '<div class="ob-section">';
    html += '<div class="ob-title">Order Book Depth</div>';

    // Summary stats
    const tradeSide = m.tradeSide;
    const bestBuyPrice = tradeSide === 'yes' ? ob.yesAsk : ob.noAsk;
    const bestSellPrice = tradeSide === 'yes' ? ob.yesBid : ob.noBid;
    const bidAskSpread = tradeSide === 'yes' ? ob.yesBidAskSpread : ob.noBidAskSpread;

    html += '<div class="ob-summary">';
    html += obStat('Best Ask (' + tradeSide.toUpperCase() + ')', bestBuyPrice != null ? fmt(bestBuyPrice) : 'NONE', bestBuyPrice != null ? 'good' : 'bad');
    html += obStat('Best Bid (' + tradeSide.toUpperCase() + ')', bestSellPrice != null ? fmt(bestSellPrice) : 'NONE', bestSellPrice != null ? 'good' : 'bad');
    html += obStat('Bid-Ask Spread', bidAskSpread != null ? (bidAskSpread * 100).toFixed(1) + 'c' : 'N/A', bidAskSpread != null ? (bidAskSpread < 0.05 ? 'good' : bidAskSpread < 0.15 ? 'warn' : 'bad') : 'bad');
    html += obStat('Fill @ Best', ob.fillAtBest.toLocaleString() + ' contracts', ob.fillAtBest > 500 ? 'good' : ob.fillAtBest > 50 ? 'warn' : 'bad');
    html += obStat('Total Depth', ob.totalDepth.toLocaleString() + ' contracts', ob.totalDepth > 1000 ? 'good' : ob.totalDepth > 100 ? 'warn' : 'bad');
    html += '</div>';

    // Liquidity warning
    if (ob.fillAtBest === 0) {
      html += '<div class="liquidity-warn">No asks on the ' + tradeSide.toUpperCase() + ' side - cannot buy at any price. The displayed divergence may be based on stale last-traded prices.</div>';
    } else if (ob.fillAtBest < contracts) {
      html += '<div class="liquidity-warn">Only ' + ob.fillAtBest + ' contracts available at best price. Your order of ' + contracts + ' would cause slippage.</div>';
    }

    // Visual order book - YES side
    html += '<div class="ob-grid">';
    html += renderObSide('YES Bids (buyers)', ob.yesBids, 'bid', ob.yesBids.concat(ob.yesAsks));
    html += renderObSide('YES Asks (sellers)', ob.yesAsks, 'ask', ob.yesBids.concat(ob.yesAsks));
    html += renderObSide('NO Bids (buyers)', ob.noBids, 'bid', ob.noBids.concat(ob.noAsks));
    html += renderObSide('NO Asks (sellers)', ob.noAsks, 'ask', ob.noBids.concat(ob.noAsks));
    html += '</div>';

    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderObSide(title, levels, type, allLevels) {
  const maxSize = Math.max(...allLevels.map(l => l.size), 1);
  let html = '<div class="ob-side">';
  html += '<div class="ob-side-title ' + type + '">' + title + '</div>';
  if (!levels.length) {
    html += '<div style="color:#484f58;font-size:11px;padding:4px 0">Empty</div>';
  } else {
    for (const l of levels) {
      const pct = (l.size / maxSize * 100).toFixed(0);
      html += '<div class="ob-row">' +
        '<div class="ob-bar ' + type + '-bar" style="width:' + pct + '%"></div>' +
        '<span class="ob-price">' + (l.price * 100).toFixed(1) + 'c</span>' +
        '<span class="ob-size">' + l.size.toLocaleString() + '</span>' +
      '</div>';
    }
  }
  html += '</div>';
  return html;
}

function obStat(label, value, cls) {
  return '<div class="ob-stat"><span class="os-label">' + label + '</span><span class="os-val ' + cls + '">' + value + '</span></div>';
}

function fmt(price, label) {
  if (price == null) return '?';
  const s = (price * 100).toFixed(1) + 'c';
  return label ? label.toUpperCase() + ' ' + s : s;
}

async function loadHistory() {
  try {
    const resp = await fetch('/api/history');
    const history = await resp.json();
    const tbody = document.getElementById('historyBody');
    const rows = [];
    for (const scan of history.slice(0, 20)) {
      const t = new Date(scan.time).toLocaleTimeString();
      for (const m of scan.results) {
        if (m.error) continue;
        const divClass = m.divergenceBps >= 500 ? 'high' : m.divergenceBps >= 200 ? 'med' : 'low';
        const recText = m.meetsThreshold ? 'BUY ' + m.tradeSide.toUpperCase() + ' @ ' + fmt(m.entryPrice) : (m.recommendation ? 'WATCH' : '-');
        const recStyle = m.meetsThreshold ? 'color:#3fb950;font-weight:700' : (m.recommendation ? 'color:#f0c000' : '');
        rows.push('<tr><td>' + t + '</td><td>' + esc(m.label) + '</td><td>' + fmt(m.kalshiPrice) + '</td><td>' + fmt(m.kalshiYesLast) + '</td><td>' + fmt(m.polyPrice) + '</td><td class="' + divClass + '">' + m.divergenceBps.toFixed(0) + '</td><td>' + m.irr.toFixed(0) + '%</td><td style="' + recStyle + '">' + recText + '</td></tr>');
      }
    }
    tbody.innerHTML = rows.join('') || '<tr><td colspan="8" class="empty">No history yet</td></tr>';
  } catch (e) {}
}

// Discovery functions
let _candidates = [];

async function doDiscover() {
  const btn = document.getElementById('discoverBtn');
  const status = document.getElementById('discoverStatus');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Scanning platforms...';
  status.textContent = 'This may take 30-60 seconds...';
  try {
    const resp = await fetch('/api/discover');
    const data = await resp.json();
    status.textContent = 'Found ' + data.pending + ' new candidates';
    _candidates = data.candidates;
    renderCandidates();
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Discover New Markets';
  }
}

async function loadCandidates() {
  try {
    const resp = await fetch('/api/candidates');
    _candidates = await resp.json();
    renderCandidates();
  } catch (e) {}
}

function renderCandidates() {
  const grid = document.getElementById('candidateGrid');
  const pending = _candidates.filter(c => c.status === 'pending');
  const approved = _candidates.filter(c => c.status === 'approved');

  if (!pending.length && !approved.length) {
    grid.innerHTML = '<div class="empty">No candidates found yet</div>';
    return;
  }

  let html = '';
  if (approved.length) {
    html += '<div style="font-size:12px;color:#3fb950;margin-bottom:8px;font-weight:600">APPROVED (' + approved.length + ')</div>';
    for (let i = 0; i < _candidates.length; i++) {
      if (_candidates[i].status === 'approved') html += renderCandidateCard(_candidates[i], i);
    }
  }
  if (pending.length) {
    html += '<div style="font-size:12px;color:#f0c000;margin:12px 0 8px;font-weight:600">PENDING REVIEW (' + pending.length + ')</div>';
    for (let i = 0; i < _candidates.length; i++) {
      if (_candidates[i].status === 'pending') html += renderCandidateCard(_candidates[i], i);
    }
  }
  grid.innerHTML = html;
}

function renderCandidateCard(c, idx) {
  const scoreColor = c.matchScore >= 0.7 ? '#3fb950' : c.matchScore >= 0.4 ? '#f0c000' : '#8b949e';
  const statusBadge = c.status === 'approved'
    ? '<span class="badge badge-buy">APPROVED</span>'
    : '<span class="badge badge-wait">PENDING</span>';

  let buttons = '';
  if (c.status === 'pending') {
    buttons = '<button class="btn" style="background:#0d3320;color:#3fb950;border-color:#3fb950;font-size:11px;padding:4px 12px" onclick="approveMarket('+idx+')">Approve</button> ' +
      '<button class="btn" style="font-size:11px;padding:4px 12px" onclick="dismissMarket('+idx+')">Dismiss</button>';
  }

  return '<div class="market-card">' +
    '<div class="title">' + statusBadge + ' <span style="color:' + scoreColor + ';font-size:11px">' + (c.matchScore * 100).toFixed(0) + '% match</span></div>' +
    '<div style="margin:8px 0">' +
      '<div style="font-size:13px"><span style="color:#8b949e">Kalshi:</span> ' + esc(c.kalshiTitle) + ' <span style="color:#484f58;font-size:11px">(' + esc(c.kalshiTicker) + ')</span></div>' +
      '<div style="font-size:13px;margin-top:4px"><span style="color:#8b949e">Poly:</span> ' + esc(c.polyQuestion) + '</div>' +
    '</div>' +
    '<div class="metrics-row">' +
      '<div class="metric"><span class="ml">Mode: </span><span class="mv">' + c.compareMode + '</span></div>' +
      '<div class="metric"><span class="ml">K Price: </span><span class="mv">' + (c.kalshiPrice != null ? (c.kalshiPrice * 100).toFixed(1) + 'c' : '?') + '</span></div>' +
      '<div class="metric"><span class="ml">P Price: </span><span class="mv">' + (c.polyPrice != null ? (c.polyPrice * 100).toFixed(1) + 'c' : '?') + '</span></div>' +
    '</div>' +
    (buttons ? '<div style="margin-top:10px">' + buttons + '</div>' : '') +
  '</div>';
}

function approveMarket(idx) {
  const c = _candidates[idx];
  if (!c) return;
  c.status = 'approved';
  renderCandidates();
  fetch('/api/candidates/approve', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ id: c.id })
  }).catch(() => {});
}

function dismissMarket(idx) {
  const c = _candidates[idx];
  if (!c) return;
  _candidates.splice(idx, 1);
  renderCandidates();
  fetch('/api/candidates/dismiss', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ id: c.id })
  }).catch(() => {});
}

// Positions
let _positions = [];

async function loadPositions() {
  const grid = document.getElementById('positionsGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="empty"><span class="spinner"></span>Loading positions...</div>';
  try {
    const [posResp, balResp] = await Promise.all([
      fetch('/api/positions'),
      fetch('/api/balance'),
    ]);
    if (!posResp.ok) throw new Error('Failed to fetch positions: ' + posResp.status);
    _positions = await posResp.json();
    const balance = balResp.ok ? await balResp.json() : {};

    const balEl = document.getElementById('balanceDisplay');
    if (balance && (balance.balance != null || balance.available != null)) {
      const bal = balance.balance ?? balance.available ?? balance.cash ?? 0;
      balEl.textContent = 'Balance: $' + (typeof bal === 'number' ? bal.toFixed(2) : bal);
    }

    renderPositions();
  } catch (e) {
    grid.innerHTML = '<div class="empty">Error loading positions: ' + esc(e.message) + '</div>';
  }
}

function renderPositions() {
  const grid = document.getElementById('positionsGrid');
  if (!_positions.length) {
    grid.innerHTML = '<div class="empty">No open positions on Kalshi</div>';
    return;
  }

  let html = '';
  for (let i = 0; i < _positions.length; i++) {
    const p = _positions[i];
    const ticker = p.marketId || '?';
    const side = p.outcomeLabel || (p.size > 0 ? 'YES' : 'NO');
    const qty = Math.abs(p.size || 0);
    const entry = p.entryPrice || null;
    const current = p.currentPrice || null;
    const pnl = p.unrealizedPnL ?? null;
    const tradeSide = p.savedSide || (p.size > 0 ? 'yes' : 'no');
    let cost = null;
    if (entry && qty) {
      cost = entry * qty;
    } else if (current != null && pnl != null && qty) {
      cost = (current * qty) - pnl;
    }
    const costStr = cost != null ? '$' + cost.toFixed(2) : '?';
    const entryStr = entry ? (entry * 100).toFixed(1) + 'c' : (cost != null && qty ? (cost / qty * 100).toFixed(1) + 'c' : '?');
    const pnlClass = pnl > 0 ? 'high' : pnl < 0 ? 'bad' : '';
    const pnlStr = pnl != null ? (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) : '?';

    html += '<div class="market-card">' +
      '<div class="title">' + esc(ticker) + ' <span class="badge badge-buy">' + esc(side) + '</span></div>' +
      '<div class="metrics-row">' +
        '<div class="metric"><span class="ml">Contracts: </span><span class="mv">' + qty + '</span></div>' +
        '<div class="metric"><span class="ml">Entry: </span><span class="mv">' + entryStr + '</span></div>' +
        (current != null ? '<div class="metric"><span class="ml">Current: </span><span class="mv">' + (current * 100).toFixed(1) + 'c</span></div>' : '') +
        '<div class="metric"><span class="ml">Cost: </span><span class="mv">' + costStr + '</span></div>' +
        '<div class="metric"><span class="ml">P&L: </span><span class="mv ' + pnlClass + '">' + pnlStr + '</span></div>' +
      '</div>' +
      '<div style="margin-top:8px;font-size:11px;color:#8b949e">Close on <a href="https://kalshi.com/portfolio" target="_blank" style="color:#58a6ff">kalshi.com/portfolio</a></div>' +
    '</div>';
  }
  grid.innerHTML = html;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

fetch('/api/status').then(r => r.json()).then(data => { if (data.markets) render(data); loadHistory(); loadCandidates(); }).catch(() => {});
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`\n  Signal BonBon Dashboard running at http://localhost:${PORT}\n`);
});
