# SynthArb Bot v2

**IRR-aware synthetic arbitrage between Polymarket and Kalshi.**

When the implied probability of the same event diverges across platforms, this bot buys YES on one and NO on the other. The combined cost is < $1.00, the payout is $1.00. Rather than holding to maturity, it exits as soon as the spread converges — maximizing capital velocity.

> ⚠ Educational project. Not financial advice. Use dry-run mode until you fully understand the execution risks.

---

## How It Works

| Step | What happens |
|------|-------------|
| **Scan** | Every N seconds, fetch live prices from Kalshi + Polymarket for all configured markets |
| **Score** | Rank opportunities by **annualized IRR**, not raw spread — a 2% spread expiring in 7 days beats a 3% spread expiring in 90 days |
| **Enter** | If spread ≥ min threshold and IRR ≥ min IRR, buy YES on cheaper platform + NO on the other |
| **Exit** | Exit when: (a) spread converges, (b) IRR drops below exit threshold, or (c) a significantly better opportunity exists elsewhere |

---

## Setup (Windows)

### 1. Install prerequisites

- **Node.js 18+**: https://nodejs.org → download the LTS `.msi` installer
- **Git**: https://git-scm.com/download/win → use default options

Open **Command Prompt** or **PowerShell** and verify:
```
node --version   # should say v18+
git --version
```

### 2. Clone and install

```bat
git clone https://github.com/YOUR_USERNAME/syntharb-bot.git
cd syntharb-bot
npm install
```

### 3. Configure credentials

```bat
copy .env.example .env
notepad .env
```

Fill in your Kalshi credentials (see below). Save and close.

> ⚠ **Never commit `.env` to GitHub.** It's already in `.gitignore`.

### 4. Get your Kalshi API keys

1. Log into [kalshi.com](https://kalshi.com)
2. Go to **Settings → API**
3. Click **Create API Key**
4. Copy the **API Key ID** → paste as `KALSHI_API_KEY`
5. Download the `.pem` file → open it in Notepad, copy the full contents → paste as `KALSHI_PRIVATE_KEY`

Your `.env` should look like:
```
KALSHI_API_KEY=abc123def456
KALSHI_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAK...
...your key...
-----END RSA PRIVATE KEY-----"
```

### 5. Configure markets

Edit `src/config.js` — update the `markets` array with the events you want to watch. You need the Kalshi market ticker (visible in the URL on kalshi.com) and the Polymarket event slug.

### 6. Test your connection

```bat
npm run test-connection
```

You should see your balance and live prices. If you get an auth error, double-check that your private key includes the `-----BEGIN/END-----` header lines.

### 7. Scan for opportunities (read-only)

```bat
npm run scan
```

Shows current spreads and IRR for all configured markets. No orders placed.

### 8. Run in dry-run mode

```bat
npm run dry
```

Bot runs fully but prints `[DRY RUN]` instead of placing real orders. Watch this for a few cycles to verify it's detecting spreads correctly.

### 9. Go live

In `.env`, set:
```
DRY_RUN=false
```

Then:
```bat
npm start
```

**Start with small position sizes** (e.g., `POSITION_SIZE_USD=50`) until you've validated execution timing.

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `true` | `false` to place real orders |
| `MIN_SPREAD_BPS` | `150` | Minimum spread in basis points (150 = 1.5%) |
| `MIN_IRR` | `20` | Minimum annualized IRR % to enter |
| `POSITION_SIZE_USD` | `100` | Dollar size per position |
| `MAX_OPEN_POSITIONS` | `3` | Max simultaneous positions |
| `POLL_INTERVAL_SECONDS` | `30` | How often to scan markets |

---

## Project Structure

```
syntharb-bot/
├── src/
│   ├── index.js          # Entry point
│   ├── bot.js            # Main poll loop, position management
│   ├── arbitrage.js      # Spread/IRR math, exit logic (pure functions)
│   ├── fetcher.js        # Live price fetching via pmxt
│   ├── executor.js       # Order placement (real + dry-run)
│   ├── config.js         # Config loaded from .env
│   ├── test-connection.js
│   └── scanner.js
├── .env.example          # Copy this to .env
├── .gitignore            # Keeps .env out of git
└── package.json
```

---

## Real Risks

- **Leg fill risk**: You might fill on Kalshi but not Polymarket (or vice versa) if the price moves between your two API calls. Market orders minimize this but don't eliminate it.
- **Withdrawal lag**: Kalshi is fiat/regulated — withdrawals take days, not seconds. Factor this into your velocity math.
- **Liquidity**: Low-volume markets may not fill your full order size at the quoted price.
- **Not risk-free**: This strategy is only mathematically guaranteed if held to maturity. Active convergence trading introduces real execution risk.

---

## Built with

- [pmxt](https://pmxt.dev) — unified prediction market API (Kalshi + Polymarket)
- [dotenv](https://github.com/motdotla/dotenv)

---

## License

MIT
