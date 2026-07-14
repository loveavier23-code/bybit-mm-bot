"""
================================================================================
 FastAPI bridge for the Bybit DEMO MM bot
================================================================================
Endpoints:
  GET  /health             -> {"status":"ok", "bot_running":bool, ...}
  GET  /state              -> full snapshot (equity, positions, orders, legs)
  POST /start              -> start bot in background thread
  POST /stop               -> stop bot gracefully
  POST /cleanup            -> cancel all orders + flatten positions
  GET  /config             -> current config values
  POST /config             -> update config values (spread threshold, etc.)
  GET  /logs?n=200         -> last N log lines
  GET  /trades             -> closed-trade history (from log parser)
  GET  /equity-history     -> sampled equity curve points

Runs on port 8000 internally. Next.js app talks to it via XTransformPort=8000.
================================================================================
"""
from __future__ import annotations

import os
import sys
import json
import time
import threading
import logging
import queue
from collections import deque
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Make the bot module importable
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

import bybit_mm_bot as B

# ----------------------------------------------------------------------------
# In-memory log capture: appends to file log + keeps last 2000 lines for API
# ----------------------------------------------------------------------------
LOG_BUFFER: deque = deque(maxlen=2000)

class BufferHandler(logging.Handler):
    def emit(self, record):
        LOG_BUFFER.append({
            "ts": record.created,
            "level": record.levelname,
            "msg": record.getMessage(),
        })

# Attach handler to the bot's logger
B.log.addHandler(BufferHandler())

# Also capture Python-level logging for the API itself
api_log = logging.getLogger("bot_api")
api_log.setLevel(logging.INFO)
api_log.addHandler(BufferHandler())

# ----------------------------------------------------------------------------
# Bot controller — singleton wrapping the SpreadEngine + a worker thread
# ----------------------------------------------------------------------------
class BotController:
    def __init__(self):
        self.client: Optional[B.BybitClient] = None
        self.scanner: Optional[B.SymbolScanner] = None
        self.engine: Optional[B.SpreadEngine] = None
        self.thread: Optional[threading.Thread] = None
        self.stop_evt = threading.Event()
        self.running = False
        self.last_error: Optional[str] = None
        self.equity_history: deque = deque(maxlen=300)  # 300 samples = ~15min at 3s poll
        self.trade_history: deque = deque(maxlen=200)
        # Track open_legs snapshot to detect newly closed trades
        self._last_legs_snapshot: Dict[str, Any] = {}
        self.lock = threading.Lock()

    def _ensure_client(self):
        if self.client is None:
            self.client = B.BybitClient(B.API_KEY, B.API_SECRET, demo=True)
            self.scanner = B.SymbolScanner(self.client)
            self.scanner.refresh_instruments()
            self.engine = B.SpreadEngine(self.client, self.scanner)
            try:
                eq, _ = self.client.get_equity()
                self.engine.equity_peak = eq
            except Exception:
                pass

    def start(self):
        with self.lock:
            if self.running:
                return {"status": "already_running"}
            self._ensure_client()
            assert self.engine is not None and self.scanner is not None
            self.stop_evt.clear()
            self.running = True
            self.last_error = None
            # Recover orphans before starting
            try:
                self.engine.recover_orphans()
            except Exception as e:
                api_log.warning(f"recover_orphans failed: {e}")
            self.thread = threading.Thread(target=self._worker, daemon=True)
            self.thread.start()
            return {"status": "started"}

    def stop(self):
        with self.lock:
            if not self.running:
                return {"status": "already_stopped"}
            self.stop_evt.set()
            self.running = False
            if self.thread:
                self.thread.join(timeout=10)
                self.thread = None
            return {"status": "stopped"}

    def _worker(self):
        api_log.info("Bot worker thread started")
        engine = self.engine
        scanner = self.scanner
        assert engine is not None and scanner is not None
        last_scan_ts = time.time()
        universe = scanner.top_universe(B.SYMBOL_UNIVERSE_SIZE)
        api_log.info(f"Worker universe ({len(universe)}): {universe}")
        while not self.stop_evt.is_set():
            try:
                if time.time() - last_scan_ts > B.SCAN_INTERVAL_SEC:
                    scanner.refresh_instruments()
                    universe = scanner.top_universe(B.SYMBOL_UNIVERSE_SIZE)
                    last_scan_ts = time.time()

                engine.step(universe)

                # Sample equity for chart
                try:
                    eq, av = self.client.get_equity()
                    self.equity_history.append({
                        "ts": time.time(),
                        "equity": eq,
                        "available": av,
                        "pending": len(engine.pending),
                        "legs": len(engine.open_legs),
                    })
                except Exception:
                    pass

                # Capture newly-closed trades
                current_legs = set(engine.open_legs.keys())
                for sym in list(self._last_legs_snapshot.keys()):
                    if sym not in current_legs:
                        # This leg closed since last snapshot
                        leg = self._last_legs_snapshot[sym]
                        self.trade_history.append({
                            "ts": time.time(),
                            "symbol": sym,
                            "side": leg["side"],
                            "entry": leg["entry"],
                            "exit": leg["hedge"],
                            "qty": leg["qty"],
                            "note": "closed",
                        })
                # Update snapshot
                self._last_legs_snapshot = {
                    sym: {
                        "side": leg.side,
                        "entry": leg.entry_price,
                        "hedge": leg.hedge_price,
                        "qty": leg.qty,
                        "open_ts": leg.open_ts,
                    }
                    for sym, leg in engine.open_legs.items()
                }

                # Sleep with periodic stop check
                for _ in range(int(B.POLL_INTERVAL_SEC * 10)):
                    if self.stop_evt.is_set(): break
                    time.sleep(0.1)
            except Exception as e:
                api_log.exception(f"Worker error: {e}")
                self.last_error = str(e)
                time.sleep(2)
        api_log.info("Bot worker thread stopped")

    def cleanup(self):
        self._ensure_client()
        assert self.client is not None
        # Stop bot first if running
        was_running = self.running
        if was_running:
            self.stop()
        self.client.cleanup_all()
        if self.engine:
            self.engine.pending.clear()
            self.engine.open_legs.clear()
        if was_running:
            # Don't auto-restart; let user explicitly start
            pass
        return {"status": "cleanup_done"}

    def snapshot(self) -> Dict[str, Any]:
        try:
            self._ensure_client()
        except Exception as e:
            api_log.error(f"_ensure_client failed: {e}")
            return {"error": f"client init failed: {e}", "bot_running": self.running}

        assert self.client is not None and self.engine is not None and self.scanner is not None
        try:
            eq, av = self.client.get_equity()
        except Exception as e:
            api_log.error(f"get_equity failed: {e}")
            return {"error": f"get_equity failed: {e}", "bot_running": self.running}

        try:
            positions = self.client.get_positions()
        except Exception as e:
            api_log.warning(f"get_positions failed: {e}")
            positions = []

        try:
            open_orders = self.client.get_open_orders()
        except Exception as e:
            api_log.warning(f"get_open_orders failed: {e}")
            open_orders = []

        # Determine runtime-excluded symbols
        excluded = sorted(self.engine.runtime_excluded | B.EXCLUDED_SYMBOLS)

        # Recent spreads from current universe — limit to 6 to keep memory/time bounded
        universe = self.scanner.top_universe(B.SYMBOL_UNIVERSE_SIZE)
        spreads = []
        for sym in universe[:8]:
            try:
                q = self.client.get_orderbook(sym, depth=3)
            except Exception:
                q = None
            if q:
                spreads.append({
                    "symbol": sym,
                    "bid": q.bid,
                    "ask": q.ask,
                    "spread_bps": round(q.spread_bps, 2),
                    "mid": q.mid,
                })

        return {
            "bot_running": self.running,
            "last_error": self.last_error,
            "equity": eq,
            "available": av,
            "equity_peak": self.engine.equity_peak,
            "positions": [
                {
                    "symbol": p.get("symbol"),
                    "side": p.get("side"),
                    "size": float(p.get("size", 0) or 0),
                    "entry_price": float(p.get("entryPrice", 0) or 0),
                    "unrealised_pnl": float(p.get("unrealisedPnl", 0) or 0),
                    "leverage": p.get("leverage"),
                    "margin": float(p.get("positionIM", 0) or 0),
                }
                for p in positions
            ],
            "open_orders": [
                {
                    "symbol": o.get("symbol"),
                    "side": o.get("side"),
                    "qty": float(o.get("qty", 0) or 0),
                    "price": float(o.get("price", 0) or 0),
                    "type": o.get("orderType"),
                    "reduce_only": o.get("reduceOnly", False),
                    "status": o.get("orderStatus"),
                    "created_at": o.get("createdTime"),
                }
                for o in open_orders
            ],
            "pending_pairs": [
                {
                    "symbol": pp.symbol,
                    "buy_price": pp.buy_price,
                    "sell_price": pp.sell_price,
                    "qty": pp.qty,
                    "age_sec": round(time.time() - pp.placed_ts, 1),
                }
                for pp in self.engine.pending.values()
            ],
            "open_legs": [
                {
                    "symbol": leg.symbol,
                    "side": leg.side,
                    "qty": leg.qty,
                    "entry_price": leg.entry_price,
                    "hedge_price": leg.hedge_price,
                    "age_sec": round(time.time() - leg.open_ts, 1),
                }
                for leg in self.engine.open_legs.values()
            ],
            "excluded_symbols": excluded,
            "universe": universe,
            "top_spreads": sorted(spreads, key=lambda s: s["spread_bps"], reverse=True)[:10],
            "config": self.get_config(),
        }

    def get_config(self) -> Dict[str, Any]:
        return {
            "per_trade_margin_pct": B.PER_TRADE_MARGIN_PCT,
            "leverage": B.LEVERAGE,
            "max_concurrent_symbols": B.MAX_CONCURRENT_SYMBOLS,
            "min_spread_bps": B.MIN_SPREAD_BPS,
            "target_capture_bps": B.TARGET_CAPTURE_BPS,
            "order_timeout_sec": B.ORDER_TIMEOUT_SEC,
            "poll_interval_sec": B.POLL_INTERVAL_SEC,
            "scan_interval_sec": B.SCAN_INTERVAL_SEC,
            "max_drawdown_pct": B.MAX_DRAWDOWN_PCT,
            "symbol_universe_size": B.SYMBOL_UNIVERSE_SIZE,
            "auto_min_notional": B.AUTO_MIN_NOTIONAL,
        }

    def update_config(self, updates: Dict[str, Any]) -> Dict[str, Any]:
        mapping = {
            "per_trade_margin_pct": ("PER_TRADE_MARGIN_PCT", float),
            "leverage": ("LEVERAGE", int),
            "max_concurrent_symbols": ("MAX_CONCURRENT_SYMBOLS", int),
            "min_spread_bps": ("MIN_SPREAD_BPS", float),
            "target_capture_bps": ("TARGET_CAPTURE_BPS", float),
            "order_timeout_sec": ("ORDER_TIMEOUT_SEC", int),
            "poll_interval_sec": ("POLL_INTERVAL_SEC", int),
            "scan_interval_sec": ("SCAN_INTERVAL_SEC", int),
            "max_drawdown_pct": ("MAX_DRAWDOWN_PCT", float),
            "symbol_universe_size": ("SYMBOL_UNIVERSE_SIZE", int),
            "auto_min_notional": ("AUTO_MIN_NOTIONAL", bool),
        }
        applied = {}
        for key, val in updates.items():
            if key not in mapping:
                continue
            attr, caster = mapping[key]
            try:
                setattr(B, attr, caster(val))
                applied[key] = caster(val)
            except (TypeError, ValueError) as e:
                api_log.warning(f"config update failed for {key}={val}: {e}")
        return {"applied": applied, "config": self.get_config()}


controller = BotController()

# ----------------------------------------------------------------------------
# FastAPI app
# ----------------------------------------------------------------------------
app = FastAPI(title="Bybit MM Bot Bridge", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Catch-all exception handler so the process never crashes on a bad request
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    import traceback
    api_log.error(f"Unhandled exception on {request.url.path}: {exc}\n{traceback.format_exc()}")
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=500,
        content={"error": str(exc), "type": type(exc).__name__},
    )


@app.get("/health")
def health():
    return {
        "status": "ok",
        "bot_running": controller.running,
        "last_error": controller.last_error,
    }


@app.get("/state")
def state():
    return controller.snapshot()


@app.post("/start")
def start_bot():
    return controller.start()


@app.post("/stop")
def stop_bot():
    return controller.stop()


@app.post("/cleanup")
def cleanup():
    return controller.cleanup()


@app.get("/config")
def get_config():
    return controller.get_config()


class ConfigUpdate(BaseModel):
    per_trade_margin_pct: Optional[float] = None
    leverage: Optional[int] = None
    max_concurrent_symbols: Optional[int] = None
    min_spread_bps: Optional[float] = None
    target_capture_bps: Optional[float] = None
    order_timeout_sec: Optional[int] = None
    poll_interval_sec: Optional[int] = None
    scan_interval_sec: Optional[int] = None
    max_drawdown_pct: Optional[float] = None
    symbol_universe_size: Optional[int] = None
    auto_min_notional: Optional[bool] = None


@app.post("/config")
def update_config(cfg: ConfigUpdate):
    updates = {k: v for k, v in cfg.dict().items() if v is not None}
    return controller.update_config(updates)


@app.get("/logs")
def get_logs(n: int = 200):
    n = max(1, min(2000, n))
    items = list(LOG_BUFFER)[-n:]
    return {"logs": items, "count": len(items)}


@app.get("/trades")
def get_trades():
    return {"trades": list(controller.trade_history)}


@app.get("/equity-history")
def get_equity_history():
    return {"points": list(controller.equity_history)}


# ----------------------------------------------------------------------------
# Main entry — uvicorn on port 8000
# ----------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    api_log.info("Starting Bybit MM Bot FastAPI bridge on port 8000")
    uvicorn.run(
        "bot_api:app",
        host="0.0.0.0",
        port=8000,
        log_level="info",
        access_log=False,
    )
