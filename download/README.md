# Bybit DEMO Market-Making Spread-Capture Bot

A Python trading bot that implements your 3-step strategy on Bybit's **demo** environment (`https://api-demo.bybit.com`):

1. **Trade short-term up/down markets** → USDT-margined perpetual futures on volatile altcoins (high-frequency churn).
2. **Don't guess direction; eat price dislocations** → places **post-only** limit orders on **both** sides of the book. We never cross the spread, we always earn it.
3. **Buy whichever side's cheaper first; wait for the other side to fill in** → when one leg fills, the opposite leg acts as a natural hedge. If it's already gone, we place a new reduce-only hedge to flatten the position and bank the spread.

## Hard rules from your spec

| Rule | Implementation |
|---|---|
| Exclude BTC and ETH | `EXCLUDED_SYMBOLS = {"BTCUSDT", "ETHUSDT"}` |
| 2% per trade | `PER_TRADE_MARGIN_PCT = 0.02` |
| 10x leverage | `LEVERAGE = 10` |
| Endpoint | `https://api-demo.bybit.com` (pybit `demo=True`) |
| API key | Hard-coded in script (demo only — do not reuse on mainnet) |

## Risk controls

- **Max 3 concurrent symbols** (don't dump all chips on one side)
- **One open position per symbol** at a time
- **45-second order timeout** — cancel and re-price if no fill
- **20% drawdown halt** — stop trading if equity falls 20% from peak
- **Runtime exclusion** — symbols requiring extra agreements (tokenized stocks like AVGOUSDT, GOOGLUSDT) are auto-excluded after first failure

## Files

| Path | Purpose |
|---|---|
| `/home/z/my-project/scripts/bybit_mm_bot.py` | The bot (single file, ~800 lines) |
| `/home/z/my-project/scripts/test_connection.py` | API connectivity sanity check |
| `/home/z/my-project/download/bot.log` | Live trading log (appended each run) |

## Usage

### 1. Test connectivity
```bash
python /home/z/my-project/scripts/test_connection.py
```
Should print `[OK]` for server time, wallet balance, instruments, orderbook, and positions.

### 2. Dry-run (scan only, no orders)
```bash
python /home/z/my-project/scripts/bybit_mm_bot.py --dry-run
```
Logs spread opportunities without placing orders. Safe to leave running.

### 3. Single live cycle
```bash
python /home/z/my-project/scripts/bybit_mm_bot.py --once --auto-min-notional
```
Runs one scan + place + reconcile pass, then exits.

### 4. Run the bot live (continuous)
```bash
python /home/z/my-project/scripts/bybit_mm_bot.py --auto-min-notional
```
Press `Ctrl+C` to stop gracefully. Open orders and positions remain on Bybit — review them on the demo UI.

### 5. Cleanup (reset demo state between runs)
```bash
python /home/z/my-project/scripts/bybit_mm_bot.py --cleanup
```
Cancels ALL open orders and flattens ALL positions with reduce-only market orders. Use this to start fresh.

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Log spreads only; don't place orders |
| `--once` | Run a single cycle and exit |
| `--auto-min-notional` | Bump size up to Bybit's 5 USDT min notional when 2% × equity × 10x < 5 USDT. **Use this on small demo balances** so trades actually place. |
| `--cleanup` | Cancel all orders, flatten all positions, exit |
| `--recover` (default on) | On startup, place reduce-only hedges for any orphaned positions from prior runs |
| `--universe N` | Set universe size (default 25) |

## How the strategy works (with example)

Suppose `LABUSDT` shows bid=0.305 / ask=0.306 (spread = 32.7 bps).

1. **Opportunity detected** — spread ≥ 8 bps threshold.
2. **Place both legs** — `Buy 17 @ 0.305` (post-only) + `Sell 17 @ 0.306` (post-only). Both rest on the book as maker orders.
3. **Wait for fills** — three scenarios:
   - **Both legs fill** (someone market-sells into our bid, then someone market-buys into our ask) → position goes long then flat. Spread = `(0.306 − 0.305) × 17 = 0.017 USDT` captured. ✓
   - **Only one leg fills** (e.g., SELL fills → we're SHORT 17 @ 0.306) → bot detects the SHORT, checks if BUY leg is still live. If yes → uses it as natural hedge (will close position when it fills). If no → places a new reduce-only BUY @ 0.305 to close. ✓
   - **Neither fills in 45s** → cancel both, re-price. No risk taken.
4. **Cycle repeats** on the next opportunity.

## Why some symbols are auto-excluded

Bybit's tokenized stock perps (AVGOUSDT, GOOGLUSDT, BABAUSDT, MUUSDT, etc.) require a separate trading agreement. The bot tries them once, gets `ErrCode: 110126`, and excludes them for the rest of the session. You'll see `[RUNTIME-EXCLUDE]` in the log.

## Important caveat on the 2% rule

Your demo account has ~14 USDT. Strict 2% × 10x = 2.86 USDT notional per trade, but Bybit's minimum notional is 5 USDT. So with strict 2%, **no trades would place**. Options:

- **Recommended for testing**: run with `--auto-min-notional` (bumps size to 5 USDT, slightly violates 2% rule but lets the bot actually trade).
- **Strict 2%**: top up the demo account to ≥ 25 USDT (so 2% × 10x ≥ 5 USDT), then run without `--auto-min-notional`.

## Configuration knobs (top of script)

Edit `bybit_mm_bot.py` to tune:

```python
PER_TRADE_MARGIN_PCT = 0.02     # 2% per trade
LEVERAGE = 10                    # 10x
MAX_CONCURRENT_SYMBOLS = 3       # spread risk
MIN_SPREAD_BPS = 8               # min spread to bother (0.08%)
ORDER_TIMEOUT_SEC = 45           # cancel if no fill
POLL_INTERVAL_SEC = 3            # main loop sleep
MAX_DRAWDOWN_PCT = 0.20          # halt threshold
SYMBOL_UNIVERSE_SIZE = 25        # top-N by 24h turnover
```

## Monitoring

- **Live log**: `tail -f /home/z/my-project/download/bot.log`
- **Bybit demo UI**: positions/orders should match what the bot reports
- **Key log lines to watch**:
  - `[OPP]` — opportunity detected, orders placed
  - `[FILL]` — one leg filled, hedging
  - `[CLOSE]` — cycle complete, position closed
  - `[TIMEOUT]` — orders cancelled, will re-price
  - `[RUNTIME-EXCLUDE]` — symbol blacklisted this session
  - `[RECOVER]` — orphaned position from prior run being hedged
  - `[STATUS]` — equity / pending / legs snapshot each poll

## Known limitations

1. **Polling, not WebSocket** — simpler and reliable, but adds ~3s latency vs WS. Fine for demo; for production, switch to pybit's WebSocket client.
2. **Single-threaded** — one symbol processed at a time in the reconcile loop. With 25 symbols and 3s poll, full scan takes ~10s. Acceptable for demo.
3. **No funding rate awareness** — bot ignores funding payments. On perps held through funding windows, this affects PnL. Mitigation: order timeout (45s) is shorter than funding interval (8h), so unlikely to matter.
4. **Hedge pricing** — when placing a new reduce-only hedge (opposite leg already gone), the bot prices it at the **original** opposite-leg price (passive). This may take a while to fill if price moves away. For more aggressive closing, edit `_on_buy_filled` / `_on_sell_filled` to price at current best bid/ask.

## Disclaimer

This bot trades on the **DEMO** environment only. No real funds are at risk. Do **NOT** reuse the API keys on mainnet — they are visible in the script. To go live, generate new keys, change `demo=True` to `demo=False` in `BybitClient(...)`, and re-test with `--dry-run` first.
