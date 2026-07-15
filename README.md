# Bybit MM Bot

A market-making spread-capture trading bot for Bybit's **demo** environment, with a full-stack Next.js dashboard for live monitoring and control.

## Strategy

1. **Trade short-term altcoin perps** — USDT-margined perpetual futures on Bybit (excludes BTC/ETH per your spec)
2. **Don't guess direction; eat price dislocations** — places **post-only** limit orders on **both** sides of the book simultaneously. Never crosses the spread, always earns it.
3. **Buy whichever side's cheaper first; wait for the other side to fill in** — when one leg fills, the opposite leg acts as a natural hedge. If gone, places a new reduce-only hedge to flatten the position and bank the spread.

## Features

- **Web dashboard** (Next.js 16 + TypeScript + Tailwind + shadcn/ui)
  - Live equity curve chart (samples every 3s)
  - 8 stat cards: Equity, PnL vs Peak, Unrealised PnL, Realized PnL (net), Gross PnL, Total Fees, Win Rate, Active Cycles
  - 4 tabs: Positions & Orders, Live Spreads (full universe scan), Trade History (with per-trade PnL/fees), Config
  - Dark mode toggle
  - Start/Stop/Cleanup controls with confirmation dialogs
  - Manual per-position close button
  - Config editor with "unsaved changes" protection (edits survive polling)
- **Smart stop-loss**
  - Adverse-move SL: market-close if unrealised loss exceeds `max_adverse_bps` (default 12 bps)
  - Hedge timeout: market-close if hedge doesn't fill in `hedge_timeout_sec` (default 15s)
  - Spread-collapse abort: market-close if spread drops below threshold at fill time
  - Smart hedge re-pricing: re-prices hedge to current best opposite quote instead of stale original
- **Accurate PnL accounting**
  - Fetches actual fill prices from Bybit execution API (not intended limit prices)
  - Tracks both entry and exit fees (signed: maker rebates negative, taker fees positive)
  - Records ALL close types (natural fill, SL-adverse, SL-timeout, spread-collapse) — no silent drops
  - Per-trade Gross PnL, Fees, and Net PnL columns
- **Risk controls**
  - 2% margin per trade, 10x leverage (configurable)
  - Max concurrent symbols (default 2)
  - Max drawdown halt (default 15%)
  - Auto-excludes symbols requiring agreements (tokenized stocks like AVGOUSDT, GOOGLUSDT)
  - BTC/ETH hard-excluded per strategy spec

## Quick Start

### Prerequisites
- Node.js 18+ and [Bun](https://bun.sh/)
- A Bybit DEMO account with API keys (get them from https://demo.bybit.com/ -> API Management)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/loveavier23-code/bybit-mm-bot.git
cd bybit-mm-bot

# 2. Install dependencies
bun install

# 3. Configure API keys (NEVER commit these)
cp .env.example .env.local
# Edit .env.local and fill in your Bybit DEMO API keys:
#   BYBIT_API_KEY=your_key
#   BYBIT_API_SECRET=your_secret

# 4. (Optional) Install Python deps if you want the CLI bot
pip install pybit pandas

# 5. Start the dev server
bun run dev
```

Open http://localhost:3000 in your browser.

### Recommended Config (for profitability)

Bybit DEMO charges 4 bps maker fee and 7.5-11 bps taker fee (~8 bps round-trip for maker-maker). To profit, set these in the Config tab:

| Parameter | Value | Why |
|---|---|---|
| `min_spread_bps` | 20 | Must exceed ~8 bps round-trip fees with margin |
| `target_capture_bps` | 12 | Aim for 12 bps net per cycle |
| `max_adverse_bps` | 12 | Tighter SL — don't give back more than captured |
| `hedge_timeout_sec` | 15 | Free capital faster if hedge stalls |
| `order_timeout_sec` | 30 | Re-price faster |
| `max_concurrent_symbols` | 2 | Less risk, more focus |
| `max_drawdown_pct` | 15% | Tighter halt |

## Architecture

```
src/
├── app/
│   ├── page.tsx                    # Main dashboard UI
│   ├── layout.tsx                  # Root layout + Sonner toaster
│   └── api/bot/[...path]/route.ts  # API routes proxying to singleton
├── lib/
│   ├── bot-service.ts              # In-process bot singleton (full strategy)
│   └── bot-api.ts                  # Frontend API client + types
scripts/
├── bybit_mm_bot.py                 # Original Python CLI bot (alternative)
├── test_connection.py              # API connectivity sanity check
└── bot_api.py                      # Python FastAPI bridge (alternative)
```

The bot runs **in-process** as a TypeScript singleton (`src/lib/bot-service.ts`) — no external bridge process needed. State is shared via module-level variables, and a `setInterval` worker drives the trading loop.

## API Endpoints

All under `/api/bot/<path>`:

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Bot status + Bybit reachability check |
| GET | `/state` | Full snapshot (equity, positions, orders, spreads, config, stats) |
| POST | `/start` | Start bot in background |
| POST | `/stop` | Stop bot + cancel pending MM pairs |
| POST | `/cleanup` | Cancel all orders + flatten all positions |
| POST | `/close-position` | Body: `{symbol}` — manually close one position |
| GET/POST | `/config` | Read/update config live |
| GET | `/logs?n=200` | Last N log entries |
| GET | `/trades` | Closed-trade history with PnL/fees |
| GET | `/equity-history` | Sampled equity curve points |

## Disclaimer

- This bot trades on the **DEMO** environment only. No real funds are at risk.
- **Never commit API keys to git.** Use `.env.local` (gitignored).
- The strategy is profitable only when captured spread exceeds round-trip fees (~8 bps on Bybit demo). Use `min_spread_bps=20` or higher.
- This is not financial advice. Trade at your own risk.

## License

MIT
