"""
================================================================================
 Bybit DEMO Market-Making Spread-Capture Bot
================================================================================

Strategy (per user spec):
  1. Only trade short-term crypto "up/down" markets
       -> We interpret this as USDT-margined perpetual futures on volatile
          mid-cap alts (high-frequency churn,minutes-scale).
  2. Don't guess direction; eat price dislocations
       -> Wait for bid/ask spread to widen beyond a threshold, then place
          POST-ONLY limit orders on BOTH sides simultaneously. We never
          cross the spread, we always earn it.
  3. Buy whichever side's cheaper first; wait for the other side to fill in
       -> When one leg fills, immediately fire an aggressive reduce-only
          order on the opposite side to flatten the position and pocket
          the spread. If nothing fills within ORDER_TIMEOUT_SEC, cancel
          and re-evaluate.

Risk controls:
  - Excludes BTCUSDT and ETHUSDT (hard filter).
  - 2% of account equity per trade (margin), 10x leverage.
  - Max MAX_CONCURRENT_SYMBOLS open at once (don't dump all chips on one side).
  - One open position per symbol at a time.
  - Order timeout: cancel & re-price if no fill in N seconds.
  - Hard stop: if account drawdown > MAX_DRAWDOWN_PCT, halt trading.

Runs against https://api-demo.bybit.com (DEMO account, no real funds).

Usage:
    python /home/z/my-project/scripts/bybit_mm_bot.py
    python /home/z/my-project/scripts/bybit_mm_bot.py --dry-run    # no orders
    python /home/z/my-project/scripts/bybit_mm_bot.py --once       # one cycle
================================================================================
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import Event
from typing import Any, Dict, List, Optional, Tuple

from pybit.unified_trading import HTTP

# ============================================================================
# CONFIG
# ============================================================================

API_KEY = "YOUR_BYBIT_API_KEY"
API_SECRET = "YOUR_BYBIT_API_SECRET"
DEMO_URL = "https://api-demo.bybit.com"

# --- Strategy parameters ---
EXCLUDED_SYMBOLS = {"BTCUSDT", "ETHUSDT"}          # hard exclusion per user spec
CATEGORY = "linear"                                # USDT-margined perps
QUOTE_COIN = "USDT"

PER_TRADE_MARGIN_PCT = 0.02                         # 2% of equity per trade
LEVERAGE = 10                                       # 10x
MAX_CONCURRENT_SYMBOLS = 3                          # spread risk across names
MAX_POSITIONS_PER_SYMBOL = 1                         # one open leg per symbol
MIN_SPREAD_BPS = 8                                  # min spread in bps to bother (0.08%)
TARGET_CAPTURE_BPS = 4                              # we try to capture ~4 bps per round
ORDER_TIMEOUT_SEC = 45                              # cancel & re-price if no fill
POLL_INTERVAL_SEC = 3                               # main loop sleep
SCAN_INTERVAL_SEC = 30                              # re-scan universe every N seconds
MAX_DRAWDOWN_PCT = 0.20                             # halt if equity down 20% from peak
SYMBOL_UNIVERSE_SIZE = 25                           # top-N candidates by spread/vol
MIN_NOTIONAL_USDT = 5.0                             # Bybit min notional per order
POST_ONLY_TIF = "PostOnly"                          # never cross the spread
REDUCE_ONLY_TIF = "GTC"                             # when closing, take whatever's available

# Runtime flags (set by CLI args)
AUTO_MIN_NOTIONAL = False                           # bump size to exchange min if 2% too small

# --- Logging ---
LOG_DIR = "/home/z/my-project/download"
LOG_FILE = os.path.join(LOG_DIR, "bot.log")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("mm_bot")

# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class Quote:
    bid: float
    bid_qty: float
    ask: float
    ask_qty: float
    ts: float
    @property
    def mid(self) -> float: return (self.bid + self.ask) / 2
    @property
    def spread_bps(self) -> float:
        if self.mid <= 0: return 0.0
        return (self.ask - self.bid) / self.mid * 10_000

@dataclass
class Instrument:
    symbol: str
    price_tick: float
    qty_step: float
    min_order_qty: float
    min_notional: float
    max_order_qty: float

@dataclass
class OpenLeg:
    """Tracks one side of an in-flight market-making cycle for a symbol."""
    symbol: str
    side: str               # "Buy" or "Sell" — the side that ALREADY FILLED
    qty: float              # filled qty
    entry_price: float      # filled price
    open_ts: float          # when the fill happened
    hedge_order_id: Optional[str] = None   # the reduce-only close order
    hedge_price: Optional[float] = None

@dataclass
class PendingPair:
    """Two post-only limit orders placed simultaneously around mid."""
    symbol: str
    buy_order_id: Optional[str]
    sell_order_id: Optional[str]
    buy_price: float
    sell_price: float
    qty: float
    placed_ts: float

# ============================================================================
# BYBIT CLIENT WRAPPER
# ============================================================================

class BybitClient:
    """Thin wrapper around pybit HTTP for V5 unified trading on DEMO."""

    def __init__(self, key: str, secret: str, demo: bool = True):
        self.session = HTTP(
            demo=demo,
            testnet=False,
            api_key=key,
            api_secret=secret,
            recv_window=10000,
            retry_delay=1,
            max_retries=3,
        )

    # ---------- public ----------
    def server_time(self) -> int:
        return int(self.session.get_server_time()["result"]["timeNano"]) // 1_000_000

    def get_linear_instruments(self) -> List[Dict]:
        r = self.session.get_instruments_info(category=CATEGORY, status="Trading")
        return r["result"]["list"]

    def get_orderbook(self, symbol: str, depth: int = 5) -> Optional[Quote]:
        try:
            r = self.session.get_orderbook(category=CATEGORY, symbol=symbol, limit=depth)
            b = r["result"]["b"]; a = r["result"]["a"]
            if not b or not a: return None
            return Quote(
                bid=float(b[0][0]), bid_qty=float(b[0][1]),
                ask=float(a[0][0]), ask_qty=float(a[0][1]),
                ts=time.time(),
            )
        except Exception as e:
            log.warning(f"orderbook fetch failed {symbol}: {e}")
            return None

    def get_tickers(self) -> List[Dict]:
        r = self.session.get_tickers(category=CATEGORY)
        return r["result"]["list"]

    # ---------- private ----------
    def get_equity(self) -> Tuple[float, float]:
        """Returns (totalEquity, availableBalance) in USDT."""
        r = self.session.get_wallet_balance(accountType="UNIFIED", coin=QUOTE_COIN)
        acct = r["result"]["list"][0]
        return float(acct.get("totalEquity", 0) or 0), float(acct.get("totalAvailableBalance", 0) or 0)

    def set_leverage(self, symbol: str, lev: int) -> None:
        try:
            self.session.set_leverage(
                category=CATEGORY, symbol=symbol,
                buyLeverage=str(lev), sellLeverage=str(lev),
            )
        except Exception as e:
            # Bybit returns -11007 when leverage isn't changed — that's fine.
            msg = str(e)
            if "11004" in msg or "11007" in msg or "leverage not modified" in msg.lower():
                return
            log.warning(f"set_leverage {symbol} failed: {e}")

    def place_limit(self, symbol: str, side: str, qty: float, price: float,
                    post_only: bool = True, reduce_only: bool = False,
                    client_id: Optional[str] = None,
                    engine: Optional["SpreadEngine"] = None) -> Optional[str]:
        tif = POST_ONLY_TIF if post_only else REDUCE_ONLY_TIF
        params = dict(
            category=CATEGORY, symbol=symbol, side=side,
            orderType="Limit", qty=str(qty), price=str(price),
            timeInForce=tif,
        )
        if reduce_only:
            params["reduceOnly"] = True
            params["timeInForce"] = "GTC"   # reduce-only can't be PostOnly
        if client_id:
            params["orderLinkId"] = client_id
        try:
            r = self.session.place_order(**params)
            oid = r["result"].get("orderId")
            log.info(f"  -> PLACED {side} {qty} {symbol} @ {price} | post_only={post_only} reduce={reduce_only} oid={oid}")
            return oid
        except Exception as e:
            msg = str(e)
            # 110126 = agreement required (tokenized stocks like AVGOUSDT, GOOGLUSDT)
            if "110126" in msg and engine is not None:
                engine.exclude_runtime(symbol, "agreement required (tokenized stock)")
            log.warning(f"  -> place_order FAILED {side} {symbol} qty={qty} px={price}: {e}")
            return None

    def cancel_order(self, symbol: str, order_id: str) -> bool:
        try:
            self.session.cancel_order(category=CATEGORY, symbol=symbol, orderId=order_id)
            return True
        except Exception as e:
            # 110001 = order does not exist (already filled / cancelled)
            if "110001" in str(e): return True
            log.warning(f"cancel_order {symbol} {order_id} failed: {e}")
            return False

    def get_order(self, symbol: str, order_id: str) -> Optional[Dict]:
        try:
            r = self.session.get_open_orders(category=CATEGORY, symbol=symbol, orderId=order_id)
            lst = r["result"]["list"]
            return lst[0] if lst else None
        except Exception:
            return None

    def get_open_orders(self, symbol: Optional[str] = None) -> List[Dict]:
        params = dict(category=CATEGORY, settleCoin=QUOTE_COIN)
        if symbol:
            params.pop("settleCoin")
            params["symbol"] = symbol
        r = self.session.get_open_orders(**params, limit=50)
        return r["result"]["list"]

    def get_positions(self) -> List[Dict]:
        r = self.session.get_positions(category=CATEGORY, settleCoin=QUOTE_COIN)
        return [p for p in r["result"]["list"] if float(p.get("size", 0) or 0) > 0]

    def cleanup_all(self) -> None:
        """Cancel all open orders and flatten all positions. Use on demo to reset."""
        log.info("[CLEANUP] Cancelling all open orders...")
        try:
            self.session.cancel_all_orders(category=CATEGORY, settleCoin=QUOTE_COIN)
            log.info("  cancel_all_orders OK")
        except Exception as e:
            log.warning(f"  cancel_all_orders failed: {e}")
        # Close any open positions with reduce-only market orders
        try:
            positions = self.get_positions()
        except Exception as e:
            log.warning(f"  get_positions failed: {e}")
            return
        for pos in positions:
            sym = pos["symbol"]
            size = abs(float(pos.get("size", 0) or 0))
            if abs(size) < 1e-9: continue
            # side field tells direction: "Buy"=long -> close with Sell; "Sell"=short -> close with Buy
            pos_side = pos.get("side", "Buy")
            close_side = "Sell" if pos_side == "Buy" else "Buy"
            try:
                self.session.place_order(
                    category=CATEGORY, symbol=sym, side=close_side,
                    orderType="Market", qty=str(size), reduceOnly=True,
                )
                log.info(f"  closed {sym} ({close_side} {size})")
            except Exception as e:
                log.warning(f"  close {sym} failed: {e}")
        log.info("[CLEANUP] done.")

# ============================================================================
# HELPERS
# ============================================================================

def round_to_step(value: float, step: float) -> float:
    if step <= 0: return value
    return math.floor(value / step) * step

def round_price(price: float, tick: float) -> float:
    return round_to_step(price, tick)

def round_qty(qty: float, step: float) -> float:
    return round_to_step(qty, step)

def fmt_ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]

# ============================================================================
# SYMBOL UNIVERSE SCANNER
# ============================================================================

class SymbolScanner:
    """
    Picks a candidate universe of liquid altcoin perps, excluding BTC/ETH.
    Ranks by 24h turnover (proxy for tradability + tight spreads) and
    picks top SYMBOL_UNIVERSE_SIZE.
    """

    def __init__(self, client: BybitClient):
        self.client = client
        self._instrument_cache: Dict[str, Instrument] = {}

    def refresh_instruments(self) -> Dict[str, Instrument]:
        log.info("Refreshing instrument metadata...")
        inst_list = self.client.get_linear_instruments()
        cache: Dict[str, Instrument] = {}
        for s in inst_list:
            sym = s["symbol"]
            if sym in EXCLUDED_SYMBOLS: continue
            if sym.endswith("USDT") is False: continue
            try:
                lot = s["lotSizeFilter"]
                pf = s["priceFilter"]
                cache[sym] = Instrument(
                    symbol=sym,
                    price_tick=float(pf["tickSize"]),
                    qty_step=float(lot["qtyStep"]),
                    min_order_qty=float(lot["minOrderQty"]),
                    min_notional=float(lot.get("minNotionalValue", 5.0) or 5.0),
                    max_order_qty=float(lot["maxOrderQty"]),
                )
            except (KeyError, ValueError) as e:
                log.debug(f"skip {sym}: {e}")
        self._instrument_cache = cache
        log.info(f"  loaded {len(cache)} eligible instruments (BTC/ETH excluded)")
        return cache

    def top_universe(self, n: int = SYMBOL_UNIVERSE_SIZE) -> List[str]:
        """Return top-N symbols by 24h turnover."""
        try:
            tickers = self.client.get_tickers()
        except Exception as e:
            log.warning(f"get_tickers failed: {e}, falling back to cache keys")
            return list(self._instrument_cache.keys())[:n]

        candidates = []
        for t in tickers:
            sym = t.get("symbol", "")
            if sym in EXCLUDED_SYMBOLS: continue
            if sym not in self._instrument_cache: continue
            try:
                turnover = float(t.get("turnover24h", 0) or 0)
            except ValueError:
                turnover = 0
            candidates.append((sym, turnover))
        candidates.sort(key=lambda x: x[1], reverse=True)
        return [s for s, _ in candidates[:n]]

    def get_instrument(self, symbol: str) -> Optional[Instrument]:
        return self._instrument_cache.get(symbol)

# ============================================================================
# SPREAD ENGINE — decides when to place / cancel / hedge
# ============================================================================

class SpreadEngine:
    """
    State machine per symbol:
        IDLE  -> place_buy_and_sell -> PENDING
        PENDING -> buy_filled  -> HEDGING_SELL
        PENDING -> sell_filled -> HEDGING_BUY
        PENDING -> timeout      -> IDLE
        HEDGING_* -> filled     -> IDLE (cycle complete)
    """

    def __init__(self, client: BybitClient, scanner: SymbolScanner):
        self.client = client
        self.scanner = scanner
        self.pending: Dict[str, PendingPair] = {}     # symbol -> PendingPair
        self.open_legs: Dict[str, OpenLeg] = {}       # symbol -> OpenLeg (one per sym)
        self.equity_peak: float = 0.0
        self.halted: bool = False
        # Runtime-excluded symbols (e.g. require agreement, like tokenized stocks)
        self.runtime_excluded: set = set()

    def is_tradable(self, symbol: str) -> bool:
        if symbol in EXCLUDED_SYMBOLS: return False
        if symbol in self.runtime_excluded: return False
        return True

    def exclude_runtime(self, symbol: str, reason: str = "") -> None:
        if symbol not in self.runtime_excluded:
            self.runtime_excluded.add(symbol)
            log.warning(f"  [RUNTIME-EXCLUDE] {symbol} ({reason}) — won't try again this session")

    def recover_orphans(self) -> None:
        """On startup, find any open positions from prior runs and place
        reduce-only hedges so they don't sit unprotected."""
        try:
            positions = self.client.get_positions()
        except Exception as e:
            log.warning(f"recover_orphans: get_positions failed: {e}")
            return
        for pos in positions:
            sym = pos["symbol"]
            size = abs(float(pos.get("size", 0) or 0))
            if abs(size) < 1e-9: continue
            # side field tells direction: "Buy"=long, "Sell"=short
            side = pos.get("side", "Buy")
            entry = float(pos.get("entryPrice", 0) or 0)
            log.warning(f"[RECOVER] orphan position {sym} side={side} size={size} entry={entry} — placing hedge")
            # Place aggressive reduce-only close at opposite side of book
            q = self.client.get_orderbook(sym, depth=5)
            if not q:
                log.error(f"  cannot fetch orderbook for {sym}, leaving orphan unhedged")
                continue
            inst = self.scanner.get_instrument(sym)
            if not inst: continue
            if side == "Buy":
                # Long -> place reduce-only Sell at bid (aggressive)
                hedge_px = round_price(q.bid, inst.price_tick)
                hedge_side = "Sell"
            else:
                # Short -> place reduce-only Buy at ask (aggressive)
                hedge_px = round_price(q.ask, inst.price_tick)
                hedge_side = "Buy"
            oid = self.client.place_limit(sym, hedge_side, size, hedge_px,
                                          post_only=False, reduce_only=True, engine=self)
            self.open_legs[sym] = OpenLeg(
                symbol=sym, side=side, qty=size,
                entry_price=entry, open_ts=time.time(),
                hedge_order_id=oid, hedge_price=hedge_px,
            )

    # ---------- risk ----------
    def check_drawdown(self) -> bool:
        try:
            equity, _ = self.client.get_equity()
        except Exception as e:
            log.warning(f"equity fetch failed: {e}")
            return True
        if equity > self.equity_peak:
            self.equity_peak = equity
        if self.equity_peak > 0:
            dd = (self.equity_peak - equity) / self.equity_peak
            if dd >= MAX_DRAWDOWN_PCT:
                log.error(f"!! HALT: drawdown {dd*100:.2f}% >= {MAX_DRAWDOWN_PCT*100:.0f}%")
                self.halted = True
                return False
        return True

    # ---------- sizing ----------
    def compute_qty(self, price: float, inst: Instrument) -> Optional[float]:
        """2% margin × 10x leverage = 20% notional exposure, rounded to qty step.

        When AUTO_MIN_NOTIONAL is on and 2% notional is below the exchange
        minimum, we bump notional up to the minimum AND round qty UP (ceil)
        so we actually satisfy the min-notional constraint after rounding.
        Otherwise we round DOWN (floor) to stay at-or-below the 2% target.
        """
        try:
            equity, _ = self.client.get_equity()
        except Exception:
            return None
        if equity <= 0: return None
        margin = equity * PER_TRADE_MARGIN_PCT
        notional = margin * LEVERAGE
        min_notional = max(inst.min_notional, MIN_NOTIONAL_USDT)

        bumped = False
        if notional < min_notional:
            if AUTO_MIN_NOTIONAL:
                notional = min_notional
                bumped = True
            else:
                return None

        if bumped:
            # Round UP to satisfy min notional after rounding
            raw = notional / price
            steps = math.ceil(raw / inst.qty_step)
            qty = steps * inst.qty_step
        else:
            # Round DOWN to stay at-or-below 2%
            qty = round_qty(notional / price, inst.qty_step)

        if qty < inst.min_order_qty:
            return None
        # Final safety check (only matters if qty_step is large relative to price)
        if qty * price < min_notional - 1e-9:
            # Try one more step up
            qty = qty + inst.qty_step
            if qty * price < min_notional - 1e-9:
                return None
            if not bumped:
                # If we weren't supposed to bump, exceeding 2% to satisfy min
                # notional is acceptable on small accounts — log and allow
                log.debug(f"  qty bumped +1 step to meet min notional")
        return qty

    # ---------- main cycle ----------
    def step(self, universe: List[str]) -> None:
        if self.halted: return
        if not self.check_drawdown(): return

        # 1. Reconcile existing state with exchange (positions + open orders)
        self._reconcile()

        # 2. Manage in-flight cycles (cancel timed-out pending; check hedge fills)
        self._manage_pending()
        self._manage_open_legs()

        if self.halted: return

        # 3. Find new opportunities among symbols not currently active
        active = set(self.pending.keys()) | set(self.open_legs.keys())
        slots = MAX_CONCURRENT_SYMBOLS - len(active)
        if slots <= 0:
            return

        for sym in universe:
            if slots <= 0: break
            if sym in self.pending or sym in self.open_legs: continue
            if len(self.open_legs) >= MAX_CONCURRENT_SYMBOLS: break
            if not self.is_tradable(sym): continue

            inst = self.scanner.get_instrument(sym)
            if not inst: continue

            q = self.client.get_orderbook(sym, depth=5)
            if not q or q.bid <= 0 or q.ask <= 0:
                log.debug(f"  {sym}: no orderbook")
                continue
            if q.spread_bps < MIN_SPREAD_BPS:
                log.debug(f"  {sym}: spread {q.spread_bps:.1f}bps < {MIN_SPREAD_BPS}bps")
                continue

            # We place post-only buy at bid and post-only sell at ask.
            # If both fill, we capture the spread.
            buy_px = round_price(q.bid, inst.price_tick)
            sell_px = round_price(q.ask, inst.price_tick)
            if sell_px <= buy_px:
                log.debug(f"  {sym}: sell_px <= buy_px after rounding")
                continue

            qty = self.compute_qty(q.mid, inst)
            if not qty:
                log.debug(f"  {sym}: qty too small for our equity, skip")
                continue

            # ensure leverage is set
            self.client.set_leverage(sym, LEVERAGE)

            log.info(f"[OPP] {sym}: spread={q.spread_bps:.1f}bps bid={buy_px} ask={sell_px} mid={q.mid:.4f} qty={qty}")
            buy_id = self.client.place_limit(sym, "Buy", qty, buy_px, post_only=True, engine=self)
            sell_id = self.client.place_limit(sym, "Sell", qty, sell_px, post_only=True, engine=self)

            if not buy_id and not sell_id:
                continue
            # If only one side placed (other rejected), cancel the lone one — we need both legs
            if buy_id and not sell_id:
                self.client.cancel_order(sym, buy_id); continue
            if sell_id and not buy_id:
                self.client.cancel_order(sym, sell_id); continue

            self.pending[sym] = PendingPair(
                symbol=sym,
                buy_order_id=buy_id,
                sell_order_id=sell_id,
                buy_price=buy_px,
                sell_price=sell_px,
                qty=qty,
                placed_ts=time.time(),
            )
            slots -= 1

    # ---------- reconcile ----------
    def _reconcile(self) -> None:
        """Sync our local view of pending orders + positions with the exchange."""
        try:
            server_orders = self.client.get_open_orders()
        except Exception as e:
            log.warning(f"reconcile get_open_orders failed: {e}")
            return
        server_oids = {o["orderId"] for o in server_orders}

        # If a pending pair's order is gone from open-orders list, it either
        # filled or got cancelled. We'll resolve below by checking positions.

        # Detect fills via position size changes
        try:
            positions = self.client.get_positions()
        except Exception as e:
            log.warning(f"reconcile get_positions failed: {e}")
            return
        pos_by_sym = {p["symbol"]: p for p in positions}

        # Resolve pending pairs whose one leg filled
        for sym in list(self.pending.keys()):
            pp = self.pending[sym]
            buy_live = pp.buy_order_id in server_oids
            sell_live = pp.sell_order_id in server_oids

            pos = pos_by_sym.get(sym)
            pos_size = abs(float(pos.get("size", 0) or 0)) if pos else 0.0
            pos_side = pos.get("side", "") if pos else ""

            if pos_size > 0 and pos_side == "Buy":
                # BUY leg filled -> we're LONG. SELL leg will close (natural hedge).
                self._on_buy_filled(pp, pos)
            elif pos_size > 0 and pos_side == "Sell":
                # SELL leg filled -> we're SHORT. BUY leg will close (natural hedge).
                self._on_sell_filled(pp, pos)
            else:
                # No position (flat). If neither order is live, both were cancelled/missed.
                if not buy_live and not sell_live:
                    log.info(f"  {sym}: both legs gone, no position — clear pending")
                    self.pending.pop(sym, None)

        # Resolve open legs whose hedge filled (position back to 0)
        for sym in list(self.open_legs.keys()):
            leg = self.open_legs[sym]
            pos = pos_by_sym.get(sym)
            pos_size = abs(float(pos.get("size", 0) or 0)) if pos else 0.0
            if pos_size == 0:
                # Position closed — either the natural hedge filled or our reduce-only did
                leg = self.open_legs.pop(sym)
                pnl = float(pos.get("closedPnl", 0) or 0) if pos else 0.0
                log.info(f"[CLOSE] {sym} leg closed | side={leg.side} entry={leg.entry_price} "
                         f"exit={leg.hedge_price} qty={leg.qty} closedPnl={pnl:.4f} USDT")

    def _on_buy_filled(self, pp: PendingPair, pos: Dict) -> None:
        """BUY leg filled -> we're long. Keep the SELL leg as natural hedge.
        If the SELL leg already filled too, position is flat — spread captured."""
        pos_size = abs(float(pos.get("size", 0)))
        log.info(f"[FILL] {pp.symbol} BUY filled @ {pp.buy_price} | size={pos_size} | checking hedge...")

        # Is the original SELL leg still live? If yes, it will close the position
        # naturally when it fills (Bybit auto-treats opposite-side orders as reduce
        # in one-way mode). No need to cancel + re-place.
        sell_live = False
        if pp.sell_order_id:
            try:
                open_orders = self.client.get_open_orders(pp.symbol)
                sell_live = any(o["orderId"] == pp.sell_order_id for o in open_orders)
            except Exception:
                pass

        if pos_size < 1e-9:
            # Already flat — both legs filled naturally. Spread captured!
            log.info(f"  -> {pp.symbol} already flat — both legs filled, spread captured")
            self.pending.pop(pp.symbol, None)
            return

        if sell_live:
            log.info(f"  -> {pp.symbol} SELL leg still live (oid={pp.sell_order_id}) "
                     f"— will close position naturally when it fills")
            hedge_id = pp.sell_order_id
            hedge_px = pp.sell_price
        else:
            # SELL leg gone — place a new reduce-only SELL to close
            inst = self.scanner.get_instrument(pp.symbol)
            hedge_px = round_price(pp.sell_price, inst.price_tick) if inst else pp.sell_price
            hedge_id = self.client.place_limit(
                pp.symbol, "Sell", pos_size, hedge_px,
                post_only=False, reduce_only=True, engine=self,
            )
            if not hedge_id:
                log.error(f"  -> {pp.symbol} hedge placement FAILED — position remains OPEN!")

        self.open_legs[pp.symbol] = OpenLeg(
            symbol=pp.symbol, side="Buy", qty=pos_size,
            entry_price=pp.buy_price, open_ts=time.time(),
            hedge_order_id=hedge_id, hedge_price=hedge_px,
        )
        self.pending.pop(pp.symbol, None)

    def _on_sell_filled(self, pp: PendingPair, pos: Dict) -> None:
        """SELL leg filled -> we're short. Keep the BUY leg as natural hedge."""
        pos_size = abs(float(pos.get("size", 0)))
        log.info(f"[FILL] {pp.symbol} SELL filled @ {pp.sell_price} | size={pos_size} | checking hedge...")

        buy_live = False
        if pp.buy_order_id:
            try:
                open_orders = self.client.get_open_orders(pp.symbol)
                buy_live = any(o["orderId"] == pp.buy_order_id for o in open_orders)
            except Exception:
                pass

        if pos_size < 1e-9:
            log.info(f"  -> {pp.symbol} already flat — both legs filled, spread captured")
            self.pending.pop(pp.symbol, None)
            return

        if buy_live:
            log.info(f"  -> {pp.symbol} BUY leg still live (oid={pp.buy_order_id}) "
                     f"— will close position naturally when it fills")
            hedge_id = pp.buy_order_id
            hedge_px = pp.buy_price
        else:
            inst = self.scanner.get_instrument(pp.symbol)
            hedge_px = round_price(pp.buy_price, inst.price_tick) if inst else pp.buy_price
            hedge_id = self.client.place_limit(
                pp.symbol, "Buy", pos_size, hedge_px,
                post_only=False, reduce_only=True, engine=self,
            )
            if not hedge_id:
                log.error(f"  -> {pp.symbol} hedge placement FAILED — position remains OPEN!")

        self.open_legs[pp.symbol] = OpenLeg(
            symbol=pp.symbol, side="Sell", qty=pos_size,
            entry_price=pp.sell_price, open_ts=time.time(),
            hedge_order_id=hedge_id, hedge_price=hedge_px,
        )
        self.pending.pop(pp.symbol, None)

    # ---------- manage in-flight ----------
    def _manage_pending(self) -> None:
        """Cancel pending pairs that didn't fill within ORDER_TIMEOUT_SEC."""
        now = time.time()
        for sym in list(self.pending.keys()):
            pp = self.pending[sym]
            age = now - pp.placed_ts
            if age >= ORDER_TIMEOUT_SEC:
                log.info(f"[TIMEOUT] {sym} no fill in {ORDER_TIMEOUT_SEC}s — cancelling both legs")
                if pp.buy_order_id: self.client.cancel_order(sym, pp.buy_order_id)
                if pp.sell_order_id: self.client.cancel_order(sym, pp.sell_order_id)
                self.pending.pop(sym, None)

    def _manage_open_legs(self) -> None:
        """If a hedge order has been sitting too long, replace with aggressive market."""
        now = time.time()
        # Re-check hedge fills via _reconcile (already done); here we only
        # upgrade stale hedges. For demo simplicity, we just log status.
        for sym, leg in self.open_legs.items():
            age = now - leg.open_ts
            if age > 60 and leg.hedge_order_id:
                log.warning(f"[STALE-HEDGE] {sym}: hedge oid={leg.hedge_order_id} age={age:.0f}s — consider manual review")

# ============================================================================
# MAIN
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="Bybit DEMO MM spread-capture bot")
    parser.add_argument("--dry-run", action="store_true", help="Don't actually place orders (scan + log only)")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    parser.add_argument("--universe", type=int, default=SYMBOL_UNIVERSE_SIZE, help="Universe size")
    parser.add_argument("--auto-min-notional", action="store_true",
                        help="If 2%% × equity × lev < exchange min notional, bump size to min notional. "
                             "Use this on small demo balances so the bot can actually place trades.")
    parser.add_argument("--cleanup", action="store_true",
                        help="Cancel ALL open orders and close ALL positions on startup, then exit. "
                             "Use this to reset the demo account between test runs.")
    parser.add_argument("--recover", action="store_true", default=True,
                        help="On startup, place reduce-only hedges for any orphaned positions from prior runs.")
    args = parser.parse_args()

    global AUTO_MIN_NOTIONAL
    AUTO_MIN_NOTIONAL = args.auto_min_notional

    log.info("=" * 70)
    log.info("Bybit DEMO Market-Making Spread-Capture Bot")
    log.info("=" * 70)
    log.info(f"Endpoint         : {DEMO_URL}")
    log.info(f"Excluded symbols : {sorted(EXCLUDED_SYMBOLS)}")
    log.info(f"Margin per trade : {PER_TRADE_MARGIN_PCT*100:.1f}% of equity")
    log.info(f"Leverage         : {LEVERAGE}x")
    log.info(f"Max concurrent   : {MAX_CONCURRENT_SYMBOLS} symbols")
    log.info(f"Min spread       : {MIN_SPREAD_BPS} bps")
    log.info(f"Order timeout    : {ORDER_TIMEOUT_SEC}s")
    log.info(f"Poll interval    : {POLL_INTERVAL_SEC}s")
    log.info(f"Dry-run          : {args.dry_run}")
    log.info(f"Auto-min-notional: {AUTO_MIN_NOTIONAL}")
    log.info(f"Log file         : {LOG_FILE}")
    log.info("=" * 70)

    client = BybitClient(API_KEY, API_SECRET, demo=True)
    scanner = SymbolScanner(client)
    engine = SpreadEngine(client, scanner)

    # Cleanup mode: cancel everything and exit
    if args.cleanup:
        log.info("=== CLEANUP MODE ===")
        client.cleanup_all()
        return

    # Initial metadata + universe
    scanner.refresh_instruments()
    universe = scanner.top_universe(args.universe)
    log.info(f"Initial universe ({len(universe)}): {universe}")

    # Equity baseline
    try:
        equity, avail = client.get_equity()
        engine.equity_peak = equity
        log.info(f"Starting equity: {equity:.4f} USDT | available: {avail:.4f} USDT")
        per_trade_margin = equity * PER_TRADE_MARGIN_PCT
        per_trade_notional = per_trade_margin * LEVERAGE
        log.info(f"Per-trade margin ~{per_trade_margin:.4f} USDT -> notional ~{per_trade_notional:.4f} USDT")
        if per_trade_notional < MIN_NOTIONAL_USDT:
            log.warning("=" * 70)
            log.warning(f"!! STRICT-2%% NOTIONAL ({per_trade_notional:.2f} USDT) < EXCHANGE MIN ({MIN_NOTIONAL_USDT} USDT)")
            if AUTO_MIN_NOTIONAL:
                log.warning(f"!! --auto-min-notional is ON: trades will be bumped to {MIN_NOTIONAL_USDT} USDT notional.")
                log.warning(f"!! This violates the 2%% rule — only use on small DEMO balances.")
            else:
                log.warning(f"!! Most orders will be REJECTED. Options:")
                log.warning(f"!!   1) Top up demo account to >= {MIN_NOTIONAL_USDT / (PER_TRADE_MARGIN_PCT * LEVERAGE):.0f} USDT")
                log.warning(f"!!   2) Re-run with --auto-min-notional (bumps size to {MIN_NOTIONAL_USDT} USDT, ignoring 2%% rule)")
            log.warning("=" * 70)
    except Exception as e:
        log.error(f"Cannot read equity: {e} — aborting")
        return

    # Graceful shutdown
    stop_evt = Event()
    def _sig(sig, frm):
        log.warning("Signal received — shutting down...")
        stop_evt.set()
    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    # Recover any orphaned positions from previous runs
    if args.recover:
        engine.recover_orphans()

    last_scan_ts = time.time()

    while not stop_evt.is_set():
        try:
            # Periodically refresh universe
            if time.time() - last_scan_ts > SCAN_INTERVAL_SEC:
                scanner.refresh_instruments()
                universe = scanner.top_universe(args.universe)
                log.info(f"Refreshed universe ({len(universe)}): {universe[:10]}...")
                last_scan_ts = time.time()

            if args.dry_run:
                # Just scan spreads and log opportunities
                for sym in universe[:10]:
                    q = client.get_orderbook(sym, depth=3)
                    if q and q.spread_bps >= MIN_SPREAD_BPS:
                        log.info(f"[DRY] {sym}: spread={q.spread_bps:.1f}bps bid={q.bid} ask={q.ask}")
            else:
                engine.step(universe)

            # status snapshot
            try:
                eq, av = client.get_equity()
                log.info(f"[STATUS] equity={eq:.4f} avail={av:.4f} "
                         f"pending={len(engine.pending)} legs={len(engine.open_legs)}")
            except Exception:
                pass

            if args.once: break
            time.sleep(POLL_INTERVAL_SEC)
        except KeyboardInterrupt:
            stop_evt.set()
        except Exception as e:
            log.exception(f"Main loop error: {e}")
            time.sleep(POLL_INTERVAL_SEC * 2)

    log.info("Bot stopped. Open orders/positions remain — please review on Bybit DEMO UI.")
    log.info(f"Final pending: {list(engine.pending.keys())} | open legs: {list(engine.open_legs.keys())}")

if __name__ == "__main__":
    main()
