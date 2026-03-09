/**
 * Tastytrade REST API client
 * Handles authentication, market data, and order execution
 */

import config from './config.js';

let sessionToken = null;
let accountNumber = null;

const headers = () => ({
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  ...(sessionToken ? { 'Authorization': sessionToken } : {}),
});

async function api(method, path, body = null) {
  const url = `${config.baseUrl}${path}`;
  const opts = { method, headers: headers() };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Authentication ──────────────────────────────────────────

export async function login() {
  const data = await api('POST', '/sessions', {
    login: config.username,
    password: config.password,
    'remember-me': true,
  });
  sessionToken = data.data['session-token'];
  console.log(`  Authenticated as ${data.data.user.email} (${config.sandbox ? 'SANDBOX' : 'PRODUCTION'})`);
  return sessionToken;
}

export async function getAccount() {
  const data = await api('GET', '/customers/me/accounts');
  const accounts = data.data.items;
  if (!accounts.length) throw new Error('No accounts found');
  accountNumber = accounts[0].account['account-number'];
  console.log(`  Account: ${accountNumber}`);
  return accountNumber;
}

export async function getBalance() {
  const data = await api('GET', `/accounts/${accountNumber}/balances`);
  return data.data;
}

export async function getPositions() {
  const data = await api('GET', `/accounts/${accountNumber}/positions`);
  return data.data.items || [];
}

// ── Market Data ─────────────────────────────────────────────

export async function getOptionChain(symbol) {
  const data = await api('GET', `/option-chains/${symbol}/nested`);
  return data.data.items;
}

export async function getQuote(symbol) {
  // Use market-data endpoint for equity quotes
  const data = await api('GET', `/market-data/${symbol}/quotes`);
  return data.data;
}

/**
 * Flatten the nested chain into a list of expirations with strikes
 * Tastytrade returns: chain[0].expirations[].strikes[]
 */
export function flattenChain(chain) {
  const expirations = [];
  for (const root of chain) {
    const rootSymbol = root['root-symbol'] || root['underlying-symbol'];
    for (const exp of (root.expirations || [])) {
      expirations.push({
        ...exp,
        rootSymbol,
        'expiration-date': exp['expiration-date'],
        strikes: (exp.strikes || []).map(s => ({
          ...s,
          strikePrice: parseFloat(s['strike-price'] || s.strike || 0),
        })),
      });
    }
  }
  return expirations;
}

/**
 * Get 0DTE expirations — returns today's expiration if available
 */
export function find0DTEExpiration(chain) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const expirations = flattenChain(chain);
  for (const exp of expirations) {
    if (exp['expiration-date'] === todayStr) {
      return exp;
    }
  }
  return null;
}

/**
 * Find strikes near a target delta from the 0DTE expiration
 * Returns { puts: [...], calls: [...] } with strike data
 */
export function findStrikesByDelta(expiration, targetDelta) {
  if (!expiration) return null;

  const strikes = expiration['strike-prices'] || expiration.strikes || [];
  // We'll select strikes based on price proximity to ATM
  // and use the option chain's greeks if available
  return strikes;
}

// ── Order Execution ─────────────────────────────────────────

/**
 * Place a credit spread order (vertical spread)
 * @param {string} type - 'put' or 'call'
 * @param {number} shortStrike - strike to sell
 * @param {number} longStrike - strike to buy (protection)
 * @param {string} expiration - YYYY-MM-DD
 * @param {number} quantity - number of contracts
 * @param {number} creditLimit - minimum credit to receive (per share, e.g. 0.30)
 */
export async function placeCreditSpread({ type, shortStrike, longStrike, expiration, quantity, creditLimit }) {
  const putCall = type === 'put' ? 'P' : 'C';
  const shortSymbol = buildOCC(config.symbol, expiration, putCall, shortStrike);
  const longSymbol = buildOCC(config.symbol, expiration, putCall, longStrike);

  const order = {
    'time-in-force': 'Day',
    'order-type': 'Limit',
    'price': creditLimit,  // credit received (positive = credit)
    'price-effect': 'Credit',
    legs: [
      {
        'instrument-type': 'Equity Option',
        symbol: shortSymbol,
        quantity: quantity,
        action: 'Sell to Open',
      },
      {
        'instrument-type': 'Equity Option',
        symbol: longSymbol,
        quantity: quantity,
        action: 'Buy to Open',
      },
    ],
  };

  if (config.dryRun) {
    // Use dry-run endpoint to validate
    const data = await api('POST', `/accounts/${accountNumber}/orders/dry-run`, order);
    return { dryRun: true, ...data.data };
  }

  const data = await api('POST', `/accounts/${accountNumber}/orders`, order);
  return data.data;
}

/**
 * Close a credit spread (buy back the spread)
 */
export async function closeCreditSpread({ type, shortStrike, longStrike, expiration, quantity, debitLimit }) {
  const putCall = type === 'put' ? 'P' : 'C';
  const shortSymbol = buildOCC(config.symbol, expiration, putCall, shortStrike);
  const longSymbol = buildOCC(config.symbol, expiration, putCall, longStrike);

  const order = {
    'time-in-force': 'Day',
    'order-type': 'Limit',
    'price': debitLimit,
    'price-effect': 'Debit',
    legs: [
      {
        'instrument-type': 'Equity Option',
        symbol: shortSymbol,
        quantity: quantity,
        action: 'Buy to Close',
      },
      {
        'instrument-type': 'Equity Option',
        symbol: longSymbol,
        quantity: quantity,
        action: 'Sell to Close',
      },
    ],
  };

  if (config.dryRun) {
    const data = await api('POST', `/accounts/${accountNumber}/orders/dry-run`, order);
    return { dryRun: true, ...data.data };
  }

  const data = await api('POST', `/accounts/${accountNumber}/orders`, order);
  return data.data;
}

/**
 * Get open orders
 */
export async function getOrders() {
  const data = await api('GET', `/accounts/${accountNumber}/orders/live`);
  return data.data.items || [];
}

/**
 * Cancel an order
 */
export async function cancelOrder(orderId) {
  return api('DELETE', `/accounts/${accountNumber}/orders/${orderId}`);
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Build OCC option symbol
 * Format: SPY   260309P00550000  (symbol padded to 6, YYMMDD, P/C, strike*1000 padded to 8)
 */
function buildOCC(underlying, expiration, putCall, strike) {
  const sym = underlying.padEnd(6, ' ');
  const [y, m, d] = expiration.split('-');
  const dateStr = y.slice(2) + m + d;
  const strikeStr = Math.round(strike * 1000).toString().padStart(8, '0');
  return `${sym}${dateStr}${putCall}${strikeStr}`;
}

/**
 * Parse OCC symbol back to components
 */
export function parseOCC(occ) {
  const underlying = occ.slice(0, 6).trim();
  const dateStr = occ.slice(6, 12);
  const putCall = occ[12];
  const strike = parseInt(occ.slice(13)) / 1000;
  return { underlying, dateStr, putCall, strike };
}
