# Bybit DEMO Market-Making Spread-Capture Bot

A trading bot that implements your 3-step strategy on Bybit's **demo** environment (`https://api-demo.bybit.com`):

1. **Trade short-term up/down markets** → USDT-margined perpetual futures on volatile altcoins (high-frequency churn).
2. **Don't guess direction; eat price dislocations** → places **post-only** limit orders on **both** sides of the book. We never cross the spread, we always earn it.
3. **Buy whichever side's cheaper first; wait for the other side to fill in** → when one leg fills, the opposite leg acts as a natural hedge. If it's already gone, we place a new reduce-only hedge to flatten the position and bank the spread.

## Two ways to run

### 1. Web Dashboard (recommended)

Open the preview link in your browser. The dashboard provides:

- **Header** with bot status badge (RUNNING/STOPPED) and Start/Stop/Cleanup/Refresh buttons
- **4 stat cards**: Equity, PnL vs Peak, Unrealised PnL, Active Cycles
- **Equity curve** chart (recharts, samples every 3s, up to 15min history)
- **Tabs**:
  - **Positions & Orders** — 4 tables: open positions, pending MM pairs, hedge legs, raw Bybit orders
    - Each position row has a **Close** button for manual flatten (with confirmation dialog)
  - **Live Spreads** — top-10 spread opportunities with bid/ask/mid/spread/status
  - **Trade History** — closed trades + live color-coded log viewer
  - **Config** — 10 editable parameters with Apply button + excluded symbols list
- **Cleanup button** has a confirmation dialog to prevent accidental flatten
- **Stop button** automatically cancels all pending MM pairs (no orphan orders left on book)

Architecture: Next.js 16 + TypeScript + Tailwind + shadcn/ui. Bot logic runs **in-process** as a TypeScript singleton (`src/lib/bot-service.ts`) — no external bridge process needed. Bybit V5 REST API called directly via `fetch` + HMAC signing.

### 2. CLI (Python, alternative)

The original Python bot is preserved at `scripts/bybit_mm_bot.py` for terminal-mode operation:

```bash
# Dry-run (scan only, no orders)
python scripts/bybit_mm_bot.py --dry-run

# Single cycle
python scripts/bybit_mm_bot.py --once --auto-min-notional

# Run live
python scripts/bybit_mm_bot.py --auto-min-notional

# Reset demo state between runs
python scripts/bybit_mm_bot.py --cleanup
```

## Hard rules from your spec

| Rule | Implementation |
|---|---|
| Exclude BTC and ETH | `EXCLUDED_SYMBOLS = {"BTCUSDT", "ETHUSDT"}` |
| 2% per trade | `per_trade_margin_pct: 0.02` |
| 10x leverage | `leverage: 10` |
| Endpoint | `https://api-demo.bybit.com` |
| API key | Hard-coded in script (demo only — do not reuse on mainnet) |

## Risk controls

- **Max 3 concurrent symbols** (don't dump all chips on one side)
- **One open position per symbol** at a time
- **45-second order timeout** — cancel and re-price if no fill
- **20% drawdown halt** — stop trading if equity falls 20% from peak
- **Runtime exclusion** — symbols requiring extra agreements (tokenized stocks like AVGOUSDT, GOOGLUSDT) are auto-excluded after first failure
- **Stop cancels pending** — stopping the bot cancels all unfilled MM pairs (no orphan orders)
- **Manual close** — each open position has a Close button in the UI to flatten immediately

## Strategy walkthrough (example)

Suppose `LABUSDT` shows bid=0.305 / ask=0.306 (spread = 32.7 bps).

1. **Opportunity detected** — spread ≥ 8 bps threshold.
2. **Place both legs** — `Buy 17 @ 0.305` (post-only) + `Sell 17 @ 0.306` (post-only). Both rest on the book as maker orders.
3. **Wait for fills** — three scenarios:
   - **Both legs fill** → position goes long then flat. Spread = `(0.306 − 0.305) × 17 = 0.017 USDT` captured. ✓
   - **Only one leg fills** (e.g., SELL fills → SHORT 17 @ 0.306) → bot detects the SHORT, checks if BUY leg is still live. If yes → uses it as natural hedge. If no → places a new reduce-only BUY @ 0.305 to close. ✓
   - **Neither fills in 45s** → cancel both, re-price. No risk taken.
4. **Cycle repeats** on the next opportunity.

## Files

### Web dashboard (TypeScript / Next.js)

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | Main dashboard UI (header, stat cards, equity chart, 4 tabs) |
| `src/lib/bot-service.ts` | In-process bot singleton — full strategy in TypeScript |
| `src/lib/bot-api.ts` | Frontend API client + TypeScript types |
| `src/app/api/bot/[...path]/route.ts` | Next.js API routes proxying to the singleton |
| `src/app/layout.tsx` | Root layout with Sonner toaster for notifications |

### CLI (Python, alternative)

| Path | Purpose |
|---|---|
| `scripts/bybit_mm_bot.py` | Standalone CLI bot |
| `scripts/test_connection.py` | API connectivity sanity check |
| `scripts/bot_api.py` | Python FastAPI bridge (alternative to in-process TS — kept for reference) |

### Logs

| Path | Purpose |
|---|---|
| `download/bot.log` | Python CLI bot log file |
| Browser → Trade History tab | Live log stream from in-process TS bot |
| `dev.log` | Next.js dev server log |

## API endpoints (web dashboard backend)

All under `/api/bot/<path>`:

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Bot running status + last error |
| GET | `/state` | Full snapshot (equity, positions, orders, legs, spreads, config) |
| POST | `/start` | Start bot in background |
| POST | `/stop` | Stop bot + cancel pending MM pairs |
| POST | `/cleanup` | Cancel all orders + flatten all positions |
| POST | `/close-position` | Body: `{symbol}` — manually close one position |
| GET | `/config` | Current config values |
| POST | `/config` | Update config values (spread threshold, leverage, etc.) |
| GET | `/logs?n=200` | Last N log entries |
| GET | `/trades` | Closed-trade history |
| GET | `/equity-history` | Sampled equity curve points |

## Important caveat on the 2% rule

Your demo account has ~14 USDT. Strict 2% × 10x = 2.86 USDT notional per trade, but Bybit's minimum notional is 5 USDT. The bot has `auto_min_notional: true` by default — it bumps size to 5 USDT when 2% would be too small. To run strict 2% without bumping, top up the demo account to ≥ 25 USDT and toggle `auto_min_notional` off in the Config tab.

## Known limitations

1. **Polling, not WebSocket** — simpler and reliable, but adds ~3s latency vs WS. Fine for demo.
2. **In-process singleton** — bot state (equity history, trade history) is lost when the Next.js dev server restarts. Acceptable for demo; for production, persist to a database.
3. **No funding rate awareness** — bot ignores funding payments. Order timeout (45s) is shorter than funding interval (8h), so unlikely to matter.
4. **Hedge pricing** — when placing a new reduce-only hedge (opposite leg already gone), the bot prices it at the **original** opposite-leg price (passive). May take a while to fill if price moves away. Use the manual Close button to flatten immediately if needed.
5. **Tokenized stocks excluded** — AVGOUSDT, GOOGLUSDT, BABAUSDT, MUUSDT, etc. require a separate trading agreement and are auto-excluded after first failure.

## Disclaimer

This bot trades on the **DEMO** environment only. No real funds are at risk. Do **NOT** reuse the API keys on mainnet — they are visible in the source code. To go live, generate new keys, change `BASE_URL` to `https://api.bybit.com`, and re-test with `--dry-run` first (CLI) or via the Config tab (web).
