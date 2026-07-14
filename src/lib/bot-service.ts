/**
 * ============================================================================
 * Bybit MM Bot — Singleton service running inside the Next.js process
 * ============================================================================
 * This module is loaded server-side only. It exposes the same HTTP-like
 * API surface as the standalone bridge but runs in-process, avoiding the
 * need for a separate (apparently unstable) background process.
 *
 * The bot runs in a background setInterval loop and shares state via
 * module-level variables. Multiple Next.js API routes call into this
 * singleton to read state and trigger actions.
 * ============================================================================
 */

import { createHmac } from "node:crypto";

// ============================================================================
// CONFIG
// ============================================================================
const API_KEY = "YOUR_BYBIT_API_KEY";
const API_SECRET = "YOUR_BYBIT_API_SECRET";
const BASE_URL = "https://api-demo.bybit.com";
const CATEGORY = "linear";
const QUOTE_COIN = "USDT";
const EXCLUDED_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT"]);

export const botConfig = {
  per_trade_margin_pct: 0.02,
  leverage: 10,
  max_concurrent_symbols: 3,
  min_spread_bps: 8,
  target_capture_bps: 4,
  order_timeout_sec: 45,
  poll_interval_sec: 3,
  scan_interval_sec: 30,
  max_drawdown_pct: 0.20,
  symbol_universe_size: 25,
  auto_min_notional: true,
  min_notional_usdt: 5,
};

// ============================================================================
// LOGGING
// ============================================================================
export interface LogEntry { ts: number; level: string; msg: string }
const logBuffer: LogEntry[] = [];
const MAX_LOGS = 2000;

function botLog(level: string, msg: string) {
  const entry = { ts: Date.now() / 1000, level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  const time = new Date(entry.ts * 1000).toISOString().split("T")[1].split(".")[0];
  // Use console.log so it appears in dev.log
  console.log(`[bot] ${time} | ${level.padEnd(7)} | ${msg}`);
}

// ============================================================================
// BYBIT REST CLIENT
// ============================================================================
interface Instrument {
  symbol: string;
  price_tick: number;
  qty_step: number;
  min_order_qty: number;
  min_notional: number;
  max_order_qty: number;
}

interface Quote {
  bid: number; ask: number; bid_qty: number; ask_qty: number;
  mid: number; spread_bps: number;
}

let instrumentCache: Map<string, Instrument> = new Map();
let instrumentsLoaded = false;

function sign(payload: string): string {
  const timestamp = Date.now().toString();
  const recvWindow = "10000";
  const data = `${timestamp}${API_KEY}${recvWindow}${payload}`;
  const sig = createHmac("sha256", API_SECRET).update(data).digest("hex");
  return sig;
}

async function bybitGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const paramStr = url.search.slice(1);
  const timestamp = Date.now().toString();
  const sig = sign(paramStr);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-BAPI-API-KEY": API_KEY,
      "X-BAPI-SIGN": sig,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": "10000",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bybit ${res.status}: ${text}`);
  }
  return res.json();
}

async function bybitPost(path: string, params: Record<string, any> = {}): Promise<any> {
  const paramStr = JSON.stringify(params);
  const timestamp = Date.now().toString();
  const sig = sign(paramStr);

  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "X-BAPI-API-KEY": API_KEY,
      "X-BAPI-SIGN": sig,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": "10000",
      "Content-Type": "application/json",
    },
    body: paramStr,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bybit ${res.status}: ${text}`);
  }
  return res.json();
}

// ============================================================================
// PUBLIC ENDPOINT WRAPPERS
// ============================================================================
export async function refreshInstruments(): Promise<void> {
  const r: any = await bybitGet("/v5/market/instruments-info", { category: CATEGORY, status: "Trading" });
  const list = r?.result?.list;
  if (!Array.isArray(list)) {
    throw new Error(`instruments-info returned no list: ${r?.retMsg || JSON.stringify(r)}`);
  }
  const cache = new Map<string, Instrument>();
  for (const s of list) {
    if (EXCLUDED_SYMBOLS.has(s.symbol)) continue;
    if (!s.symbol.endsWith("USDT")) continue;
    try {
      const lot = s.lotSizeFilter;
      const pf = s.priceFilter;
      cache.set(s.symbol, {
        symbol: s.symbol,
        price_tick: parseFloat(pf.tickSize),
        qty_step: parseFloat(lot.qtyStep),
        min_order_qty: parseFloat(lot.minOrderQty),
        min_notional: parseFloat(lot.minNotionalValue || "5"),
        max_order_qty: parseFloat(lot.maxOrderQty),
      });
    } catch (e) { /* skip */ }
  }
  instrumentCache = cache;
  instrumentsLoaded = true;
  botLog("INFO", `loaded ${cache.size} eligible instruments (BTC/ETH excluded)`);
}

export async function getTopUniverse(n: number): Promise<string[]> {
  const r: any = await bybitGet("/v5/market/tickers", { category: CATEGORY });
  const list = r?.result?.list;
  if (!Array.isArray(list)) return [];
  const cands: [string, number][] = [];
  for (const t of list) {
    if (EXCLUDED_SYMBOLS.has(t.symbol)) continue;
    if (!instrumentCache.has(t.symbol)) continue;
    cands.push([t.symbol, parseFloat(t.turnover24h || "0")]);
  }
  cands.sort((a, b) => b[1] - a[1]);
  return cands.slice(0, n).map(([s]) => s);
}

async function getQuote(symbol: string, depth: number = 5): Promise<Quote | null> {
  try {
    const r: any = await bybitGet("/v5/market/orderbook", { category: CATEGORY, symbol, limit: String(depth) });
    const b = r?.result?.b;
    const a = r?.result?.a;
    if (!Array.isArray(b) || !Array.isArray(a) || !b.length || !a.length) return null;
    const bid = parseFloat(b[0][0]);
    const ask = parseFloat(a[0][0]);
    const mid = (bid + ask) / 2;
    return {
      bid, ask,
      bid_qty: parseFloat(b[0][1]),
      ask_qty: parseFloat(a[0][1]),
      mid,
      spread_bps: mid > 0 ? ((ask - bid) / mid) * 10000 : 0,
    };
  } catch (e) {
    return null;
  }
}

export async function getEquity(): Promise<[number, number]> {
  const r: any = await bybitGet("/v5/account/wallet-balance", { accountType: "UNIFIED", coin: QUOTE_COIN });
  const list = r?.result?.list;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("wallet-balance returned no accounts");
  }
  const acct = list[0];
  return [
    parseFloat(acct.totalEquity || "0"),
    parseFloat(acct.totalAvailableBalance || "0"),
  ];
}

export async function getPositions(): Promise<any[]> {
  const r: any = await bybitGet("/v5/position/list", { category: CATEGORY, settleCoin: QUOTE_COIN });
  const list = r?.result?.list;
  if (!Array.isArray(list)) return [];
  return list.filter((p: any) => Math.abs(parseFloat(p.size || "0")) > 0);
}

export async function getOpenOrders(): Promise<any[]> {
  const r: any = await bybitGet("/v5/order/realtime", { category: CATEGORY, settleCoin: QUOTE_COIN, limit: "50" });
  const list = r?.result?.list;
  if (!Array.isArray(list)) return [];
  return list;
}

async function setLeverage(symbol: string, lev: number): Promise<void> {
  try {
    await bybitPost("/v5/position/set-leverage", {
      category: CATEGORY, symbol,
      buyLeverage: String(lev), sellLeverage: String(lev),
    });
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("11004") || msg.includes("11007") || msg.toLowerCase().includes("not modified")) return;
    botLog("WARNING", `set_leverage ${symbol} failed: ${msg}`);
  }
}

async function placeLimit(symbol: string, side: string, qty: number, price: number,
  opts: { post_only?: boolean; reduce_only?: boolean } = {}): Promise<string | null> {
  const tif = opts.reduce_only ? "GTC" : "PostOnly";
  const params: any = {
    category: CATEGORY, symbol, side,
    orderType: "Limit", qty: String(qty), price: String(price),
    timeInForce: tif,
  };
  if (opts.reduce_only) params.reduceOnly = true;
  try {
    const r: any = await bybitPost("/v5/order/create", params);
    // Bybit returns retCode != 0 on logical errors (e.g. agreement required)
    if (r?.retCode && r.retCode !== 0) {
      throw new Error(`Bybit retCode ${r.retCode}: ${r.retMsg || "unknown"}`);
    }
    const oid = r?.result?.orderId;
    if (!oid) {
      throw new Error(`no orderId in response: ${JSON.stringify(r)}`);
    }
    botLog("INFO", `  -> PLACED ${side} ${qty} ${symbol} @ ${price} | post_only=${!!opts.post_only} reduce=${!!opts.reduce_only} oid=${oid}`);
    return oid;
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("110126") && !runtime_excluded.has(symbol)) {
      runtime_excluded.add(symbol);
      botLog("WARNING", `  [RUNTIME-EXCLUDE] ${symbol} (agreement required) — won't try again`);
    }
    botLog("WARNING", `  -> place_order FAILED ${side} ${symbol} qty=${qty} px=${price}: ${msg}`);
    return null;
  }
}

async function cancelOrder(symbol: string, orderId: string): Promise<boolean> {
  try {
    await bybitPost("/v5/order/cancel", { category: CATEGORY, symbol, orderId });
    return true;
  } catch (e: any) {
    if ((e.message || "").includes("110001")) return true;
    botLog("WARNING", `cancel_order ${symbol} ${orderId} failed: ${e.message}`);
    return false;
  }
}

async function cancelAllOrders(): Promise<void> {
  try {
    await bybitPost("/v5/order/cancel-all", { category: CATEGORY, settleCoin: QUOTE_COIN });
    botLog("INFO", "  cancel_all_orders OK");
  } catch (e: any) {
    botLog("WARNING", `  cancel_all_orders failed: ${e.message}`);
  }
}

async function placeMarketReduceClose(symbol: string, side: string, qty: number): Promise<void> {
  try {
    await bybitPost("/v5/order/create", {
      category: CATEGORY, symbol, side,
      orderType: "Market", qty: String(qty), reduceOnly: true,
    });
    botLog("INFO", `  closed ${symbol} (${side} ${qty})`);
  } catch (e: any) {
    botLog("WARNING", `  close ${symbol} failed: ${e.message}`);
  }
}

// ============================================================================
// ROUNDING HELPERS
// ============================================================================
function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
}
function roundQty(qty: number, step: number): number { return roundToStep(qty, step); }
function roundPrice(price: number, tick: number): number { return roundToStep(price, tick); }

// ============================================================================
// BOT STATE (module-level singleton)
// ============================================================================
const runtime_excluded: Set<string> = new Set();

interface PendingPair {
  symbol: string;
  buy_order_id: string | null;
  sell_order_id: string | null;
  buy_price: number;
  sell_price: number;
  qty: number;
  placed_ts: number;
}
interface OpenLeg {
  symbol: string;
  side: string;
  qty: number;
  entry_price: number;
  hedge_price: number | null;
  open_ts: number;
  hedge_order_id: string | null;
}

const pending: Map<string, PendingPair> = new Map();
const open_legs: Map<string, OpenLeg> = new Map();
let equity_peak = 0;
let halted = false;
let bot_running = false;
let last_error: string | null = null;
let stop_requested = false;
let worker_interval: NodeJS.Timeout | null = null;

const equity_history: any[] = [];
const trade_history: any[] = [];
let last_legs_snapshot: Map<string, any> = new Map();

// ============================================================================
// BOT LOGIC
// ============================================================================
function computeQty(price: number, inst: Instrument, equity: number): number | null {
  if (equity <= 0) return null;
  const margin = equity * botConfig.per_trade_margin_pct;
  let notional = margin * botConfig.leverage;
  const min_notional = Math.max(inst.min_notional, botConfig.min_notional_usdt);

  let bumped = false;
  if (notional < min_notional) {
    if (botConfig.auto_min_notional) {
      notional = min_notional;
      bumped = true;
    } else {
      return null;
    }
  }

  let qty: number;
  if (bumped) {
    qty = Math.ceil(notional / price / inst.qty_step) * inst.qty_step;
  } else {
    qty = Math.floor(notional / price / inst.qty_step) * inst.qty_step;
  }
  if (qty < inst.min_order_qty) return null;
  if (qty * price < min_notional - 1e-9) {
    qty = qty + inst.qty_step;
    if (qty * price < min_notional - 1e-9) return null;
  }
  return qty;
}

async function reconcile(): Promise<void> {
  let server_orders: any[] = [];
  try { server_orders = await getOpenOrders(); } catch (e: any) {
    botLog("WARNING", `reconcile get_open_orders failed: ${e.message}`);
    return;
  }
  const server_oids = new Set(server_orders.map(o => o.orderId));

  let positions: any[] = [];
  try { positions = await getPositions(); } catch (e: any) {
    botLog("WARNING", `reconcile get_positions failed: ${e.message}`);
    return;
  }
  const pos_by_sym = new Map<string, any>();
  for (const p of positions) pos_by_sym.set(p.symbol, p);

  for (const sym of Array.from(pending.keys())) {
    const pp = pending.get(sym)!;
    const buy_live = pp.buy_order_id ? server_oids.has(pp.buy_order_id) : false;
    const sell_live = pp.sell_order_id ? server_oids.has(pp.sell_order_id) : false;
    const pos = pos_by_sym.get(sym);
    const pos_size = pos ? Math.abs(parseFloat(pos.size || "0")) : 0;
    const pos_side = pos ? pos.side : "";

    if (pos_size > 0 && pos_side === "Buy") {
      await onBuyFilled(pp, pos);
    } else if (pos_size > 0 && pos_side === "Sell") {
      await onSellFilled(pp, pos);
    } else {
      if (!buy_live && !sell_live) {
        botLog("INFO", `  ${sym}: both legs gone, no position — clear pending`);
        pending.delete(sym);
      }
    }
  }

  for (const sym of Array.from(open_legs.keys())) {
    const pos = pos_by_sym.get(sym);
    const pos_size = pos ? Math.abs(parseFloat(pos.size || "0")) : 0;
    if (pos_size === 0) {
      const leg = open_legs.get(sym)!;
      open_legs.delete(sym);
      botLog("INFO", `[CLOSE] ${sym} leg closed | side=${leg.side} entry=${leg.entry_price} exit=${leg.hedge_price} qty=${leg.qty}`);
    }
  }
}

async function onBuyFilled(pp: PendingPair, pos: any): Promise<void> {
  const pos_size = Math.abs(parseFloat(pos.size || "0"));
  botLog("INFO", `[FILL] ${pp.symbol} BUY filled @ ${pp.buy_price} | size=${pos_size} | checking hedge...`);

  let sell_live = false;
  if (pp.sell_order_id) {
    try {
      const o = await getOpenOrders();
      sell_live = o.some(x => x.orderId === pp.sell_order_id);
    } catch (e) { /* ignore */ }
  }

  if (pos_size < 1e-9) {
    botLog("INFO", `  -> ${pp.symbol} already flat — both legs filled, spread captured`);
    pending.delete(pp.symbol);
    return;
  }

  let hedge_id: string | null = null;
  let hedge_px: number = pp.sell_price;
  if (sell_live) {
    botLog("INFO", `  -> ${pp.symbol} SELL leg still live — will close position naturally`);
    hedge_id = pp.sell_order_id;
  } else {
    const inst = instrumentCache.get(pp.symbol);
    hedge_px = inst ? roundPrice(pp.sell_price, inst.price_tick) : pp.sell_price;
    hedge_id = await placeLimit(pp.symbol, "Sell", pos_size, hedge_px, { reduce_only: true });
    if (!hedge_id) botLog("ERROR", `  -> ${pp.symbol} hedge placement FAILED — position remains OPEN!`);
  }

  open_legs.set(pp.symbol, {
    symbol: pp.symbol, side: "Buy", qty: pos_size,
    entry_price: pp.buy_price, open_ts: Date.now() / 1000,
    hedge_order_id: hedge_id, hedge_price: hedge_px,
  });
  pending.delete(pp.symbol);
}

async function onSellFilled(pp: PendingPair, pos: any): Promise<void> {
  const pos_size = Math.abs(parseFloat(pos.size || "0"));
  botLog("INFO", `[FILL] ${pp.symbol} SELL filled @ ${pp.sell_price} | size=${pos_size} | checking hedge...`);

  let buy_live = false;
  if (pp.buy_order_id) {
    try {
      const o = await getOpenOrders();
      buy_live = o.some(x => x.orderId === pp.buy_order_id);
    } catch (e) { /* ignore */ }
  }

  if (pos_size < 1e-9) {
    botLog("INFO", `  -> ${pp.symbol} already flat — both legs filled, spread captured`);
    pending.delete(pp.symbol);
    return;
  }

  let hedge_id: string | null = null;
  let hedge_px: number = pp.buy_price;
  if (buy_live) {
    botLog("INFO", `  -> ${pp.symbol} BUY leg still live — will close position naturally`);
    hedge_id = pp.buy_order_id;
  } else {
    const inst = instrumentCache.get(pp.symbol);
    hedge_px = inst ? roundPrice(pp.buy_price, inst.price_tick) : pp.buy_price;
    hedge_id = await placeLimit(pp.symbol, "Buy", pos_size, hedge_px, { reduce_only: true });
    if (!hedge_id) botLog("ERROR", `  -> ${pp.symbol} hedge placement FAILED — position remains OPEN!`);
  }

  open_legs.set(pp.symbol, {
    symbol: pp.symbol, side: "Sell", qty: pos_size,
    entry_price: pp.sell_price, open_ts: Date.now() / 1000,
    hedge_order_id: hedge_id, hedge_price: hedge_px,
  });
  pending.delete(pp.symbol);
}

async function managePending(): Promise<void> {
  const now = Date.now() / 1000;
  for (const sym of Array.from(pending.keys())) {
    const pp = pending.get(sym)!;
    const age = now - pp.placed_ts;
    if (age >= botConfig.order_timeout_sec) {
      botLog("INFO", `[TIMEOUT] ${sym} no fill in ${botConfig.order_timeout_sec}s — cancelling both legs`);
      if (pp.buy_order_id) await cancelOrder(sym, pp.buy_order_id);
      if (pp.sell_order_id) await cancelOrder(sym, pp.sell_order_id);
      pending.delete(sym);
    }
  }
}

async function checkDrawdown(): Promise<boolean> {
  let equity = 0;
  try { [equity] = await getEquity(); } catch (e: any) {
    botLog("WARNING", `equity fetch failed: ${e.message}`);
    return true;
  }
  if (equity > equity_peak) equity_peak = equity;
  if (equity_peak > 0) {
    const dd = (equity_peak - equity) / equity_peak;
    if (dd >= botConfig.max_drawdown_pct) {
      botLog("ERROR", `!! HALT: drawdown ${dd * 100}% >= ${botConfig.max_drawdown_pct * 100}%`);
      halted = true;
      return false;
    }
  }
  return true;
}

async function step(universe: string[]): Promise<void> {
  if (halted) return;
  if (!(await checkDrawdown())) return;

  await reconcile();
  await managePending();

  if (halted) return;

  const active = new Set<string>([...pending.keys(), ...open_legs.keys()]);
  let slots = botConfig.max_concurrent_symbols - active.size;
  if (slots <= 0) return;

  for (const sym of universe) {
    if (slots <= 0) break;
    if (pending.has(sym) || open_legs.has(sym)) continue;
    if (open_legs.size >= botConfig.max_concurrent_symbols) break;
    if (runtime_excluded.has(sym) || EXCLUDED_SYMBOLS.has(sym)) continue;

    const inst = instrumentCache.get(sym);
    if (!inst) continue;

    const q = await getQuote(sym, 5);
    if (!q || q.bid <= 0 || q.ask <= 0) continue;
    if (q.spread_bps < botConfig.min_spread_bps) continue;

    const buy_px = roundPrice(q.bid, inst.price_tick);
    const sell_px = roundPrice(q.ask, inst.price_tick);
    if (sell_px <= buy_px) continue;

    let equity = 0;
    try { [equity] = await getEquity(); } catch { continue; }
    const qty = computeQty(q.mid, inst, equity);
    if (!qty) continue;

    await setLeverage(sym, botConfig.leverage);

    botLog("INFO", `[OPP] ${sym}: spread=${q.spread_bps.toFixed(1)}bps bid=${buy_px} ask=${sell_px} mid=${q.mid.toFixed(4)} qty=${qty}`);
    const buy_id = await placeLimit(sym, "Buy", qty, buy_px, { post_only: true });
    const sell_id = await placeLimit(sym, "Sell", qty, sell_px, { post_only: true });

    if (!buy_id && !sell_id) continue;
    if (buy_id && !sell_id) { await cancelOrder(sym, buy_id!); continue; }
    if (sell_id && !buy_id) { await cancelOrder(sym, sell_id!); continue; }

    pending.set(sym, {
      symbol: sym,
      buy_order_id: buy_id, sell_order_id: sell_id,
      buy_price: buy_px, sell_price: sell_px, qty,
      placed_ts: Date.now() / 1000,
    });
    slots--;
  }
}

let last_scan_ts = 0;
let universe_cache: string[] = [];

async function workerTick(): Promise<void> {
  if (stop_requested || !bot_running) return;
  try {
    const now = Date.now() / 1000;
    if (now - last_scan_ts > botConfig.scan_interval_sec || universe_cache.length === 0) {
      await refreshInstruments();
      universe_cache = await getTopUniverse(botConfig.symbol_universe_size);
      last_scan_ts = now;
    }

    await step(universe_cache);

    try {
      const [eq, av] = await getEquity();
      equity_history.push({
        ts: now, equity: eq, available: av,
        pending: pending.size, legs: open_legs.size,
      });
      if (equity_history.length > 300) equity_history.shift();
    } catch { /* ignore */ }

    const current_legs = new Set(open_legs.keys());
    for (const [sym, leg] of last_legs_snapshot) {
      if (!current_legs.has(sym)) {
        trade_history.push({
          ts: now, symbol: sym,
          side: leg.side, entry: leg.entry, exit: leg.hedge,
          qty: leg.qty, note: "closed",
        });
        if (trade_history.length > 200) trade_history.shift();
      }
    }
    last_legs_snapshot = new Map();
    for (const [sym, leg] of open_legs) {
      last_legs_snapshot.set(sym, {
        side: leg.side, entry: leg.entry_price, hedge: leg.hedge_price, qty: leg.qty,
      });
    }
  } catch (e: any) {
    botLog("ERROR", `Worker tick error: ${e.message}`);
    last_error = e.message;
  }
}

async function recoverOrphans(): Promise<void> {
  let positions: any[] = [];
  try { positions = await getPositions(); } catch (e: any) {
    botLog("WARNING", `recover_orphans: get_positions failed: ${e.message}`);
    return;
  }
  for (const pos of positions) {
    const sym = pos.symbol;
    const size = Math.abs(parseFloat(pos.size || "0"));
    if (size < 1e-9) continue;
    const side = pos.side || "Buy";
    const entry = parseFloat(pos.entryPrice || "0");
    botLog("WARNING", `[RECOVER] orphan position ${sym} side=${side} size=${size} entry=${entry} — placing hedge`);
    const q = await getQuote(sym, 5);
    if (!q) { botLog("ERROR", `  cannot fetch orderbook for ${sym}`); continue; }
    const inst = instrumentCache.get(sym);
    if (!inst) continue;
    let hedge_px: number, hedge_side: string;
    if (side === "Buy") {
      hedge_px = roundPrice(q.bid, inst.price_tick);
      hedge_side = "Sell";
    } else {
      hedge_px = roundPrice(q.ask, inst.price_tick);
      hedge_side = "Buy";
    }
    const oid = await placeLimit(sym, hedge_side, size, hedge_px, { reduce_only: true });
    open_legs.set(sym, {
      symbol: sym, side, qty: size, entry_price: entry,
      open_ts: Date.now() / 1000, hedge_order_id: oid, hedge_price: hedge_px,
    });
  }
}

async function cleanupAll(): Promise<void> {
  botLog("INFO", "[CLEANUP] Cancelling all open orders...");
  await cancelAllOrders();
  let positions: any[] = [];
  try { positions = await getPositions(); } catch { return; }
  for (const pos of positions) {
    const sym = pos.symbol;
    const size = Math.abs(parseFloat(pos.size || "0"));
    if (size < 1e-9) continue;
    const pos_side = pos.side || "Buy";
    const close_side = pos_side === "Buy" ? "Sell" : "Buy";
    await placeMarketReduceClose(sym, close_side, size);
  }
  pending.clear();
  open_legs.clear();
  botLog("INFO", "[CLEANUP] done.");
}

// ============================================================================
// PUBLIC API (called from Next.js routes)
// ============================================================================
export async function startBot(): Promise<any> {
  if (bot_running) return { status: "already_running" };
  if (!instrumentsLoaded) {
    try { await refreshInstruments(); } catch (e: any) {
      return { status: "error", error: `init failed: ${e.message}` };
    }
  }
  stop_requested = false;
  bot_running = true;
  halted = false;
  last_error = null;
  try { await recoverOrphans(); } catch (e: any) {
    botLog("WARNING", `recover failed: ${e.message}`);
  }
  // Start worker using setInterval (survives because we're in the Next.js process)
  if (worker_interval) clearInterval(worker_interval);
  const intervalMs = Math.max(1000, botConfig.poll_interval_sec * 1000);
  worker_interval = setInterval(() => {
    workerTick().catch(e => botLog("ERROR", `interval error: ${e.message}`));
  }, intervalMs);
  botLog("INFO", "Bot started");
  return { status: "started" };
}

export async function stopBot(): Promise<any> {
  if (!bot_running) return { status: "already_stopped" };
  stop_requested = true;
  bot_running = false;
  if (worker_interval) {
    clearInterval(worker_interval);
    worker_interval = null;
  }
  // Cancel any pending MM pairs so we don't leave orphan post-only orders on the book
  botLog("INFO", `Stopping bot — cancelling ${pending.size} pending pair(s)`);
  for (const [sym, pp] of Array.from(pending.entries())) {
    if (pp.buy_order_id) await cancelOrder(sym, pp.buy_order_id);
    if (pp.sell_order_id) await cancelOrder(sym, pp.sell_order_id);
    pending.delete(sym);
  }
  botLog("INFO", "Bot stopped");
  return { status: "stopped", cancelled_pairs: pending.size };
}

export async function cleanupBot(): Promise<any> {
  if (bot_running) await stopBot();
  await cleanupAll();
  return { status: "cleanup_done" };
}

/**
 * Manually close a single position by symbol with a reduce-only market order.
 * Useful if a hedge leg is stuck and the user wants to flatten immediately.
 */
export async function closePositionApi(symbol: string): Promise<any> {
  if (!symbol) return { status: "error", error: "symbol required" };
  let positions: any[] = [];
  try { positions = await getPositions(); } catch (e: any) {
    return { status: "error", error: `get_positions failed: ${e.message}` };
  }
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) return { status: "not_found", symbol };
  const size = Math.abs(parseFloat(pos.size || "0"));
  if (size < 1e-9) return { status: "no_position", symbol };
  const pos_side = pos.side || "Buy";
  const close_side = pos_side === "Buy" ? "Sell" : "Buy";
  botLog("INFO", `[MANUAL CLOSE] ${symbol} side=${pos_side} size=${size} -> placing ${close_side} market reduce-only`);
  // Also cancel any existing hedge limit order so it doesn't conflict
  const leg = open_legs.get(symbol);
  if (leg?.hedge_order_id) {
    await cancelOrder(symbol, leg.hedge_order_id);
  }
  // Cancel any pending pair too
  const pp = pending.get(symbol);
  if (pp) {
    if (pp.buy_order_id) await cancelOrder(symbol, pp.buy_order_id);
    if (pp.sell_order_id) await cancelOrder(symbol, pp.sell_order_id);
    pending.delete(symbol);
  }
  await placeMarketReduceClose(symbol, close_side, size);
  open_legs.delete(symbol);
  return { status: "closed", symbol, side: close_side, size };
}

export async function getSnapshot(): Promise<any> {
  if (!instrumentsLoaded) {
    try { await refreshInstruments(); } catch (e: any) {
      return { error: `init failed: ${e.message}`, bot_running };
    }
  }

  let equity = 0, available = 0;
  try { [equity, available] = await getEquity(); } catch (e: any) {
    return { error: `get_equity failed: ${e.message}`, bot_running };
  }

  let positions: any[] = [];
  try { positions = await getPositions(); } catch { /* ignore */ }

  let open_orders: any[] = [];
  try { open_orders = await getOpenOrders(); } catch { /* ignore */ }

  const excluded = Array.from(new Set([...runtime_excluded, ...EXCLUDED_SYMBOLS])).sort();

  // Fetch top spreads (limit to 6 for speed)
  let universe: string[] = universe_cache;
  if (universe.length === 0) {
    try { universe = await getTopUniverse(botConfig.symbol_universe_size); } catch { universe = []; }
  }
  const spreads: any[] = [];
  for (const sym of universe.slice(0, 6)) {
    const q = await getQuote(sym, 3);
    if (q) {
      spreads.push({
        symbol: sym, bid: q.bid, ask: q.ask,
        spread_bps: Math.round(q.spread_bps * 100) / 100, mid: q.mid,
      });
    }
  }

  return {
    bot_running,
    last_error,
    equity,
    available,
    equity_peak,
    positions: positions.map(p => ({
      symbol: p.symbol,
      side: p.side,
      size: Math.abs(parseFloat(p.size || "0")),
      entry_price: parseFloat(p.entryPrice || "0"),
      unrealised_pnl: parseFloat(p.unrealisedPnl || "0"),
      leverage: p.leverage,
      margin: parseFloat(p.positionIM || "0"),
    })),
    open_orders: open_orders.map(o => ({
      symbol: o.symbol, side: o.side,
      qty: parseFloat(o.qty || "0"), price: parseFloat(o.price || "0"),
      type: o.orderType, reduce_only: o.reduceOnly || false,
      status: o.orderStatus, created_at: o.createdTime,
    })),
    pending_pairs: Array.from(pending.values()).map(p => ({
      symbol: p.symbol, buy_price: p.buy_price, sell_price: p.sell_price,
      qty: p.qty, age_sec: Math.round((Date.now() / 1000) - p.placed_ts),
    })),
    open_legs: Array.from(open_legs.values()).map(l => ({
      symbol: l.symbol, side: l.side, qty: l.qty,
      entry_price: l.entry_price, hedge_price: l.hedge_price,
      age_sec: Math.round((Date.now() / 1000) - l.open_ts),
    })),
    excluded_symbols: excluded,
    universe,
    top_spreads: spreads.sort((a, b) => b.spread_bps - a.spread_bps).slice(0, 10),
    config: { ...botConfig },
  };
}

export function getLogs(n: number = 200): LogEntry[] {
  return logBuffer.slice(-Math.max(1, Math.min(2000, n)));
}

export function getTrades(): any[] {
  return trade_history;
}

export function getEquityHistory(): any[] {
  return equity_history;
}

export function getConfig(): any {
  return { ...botConfig };
}

export function updateConfig(updates: Record<string, any>): { applied: any; config: any } {
  const applied: any = {};
  for (const [k, v] of Object.entries(updates)) {
    if (k in botConfig && v !== null && v !== undefined) {
      (botConfig as any)[k] = v;
      applied[k] = v;
    }
  }
  // If poll_interval changed and bot is running, restart the interval
  if (botConfig.poll_interval_sec && worker_interval) {
    clearInterval(worker_interval);
    const intervalMs = Math.max(1000, botConfig.poll_interval_sec * 1000);
    worker_interval = setInterval(() => {
      workerTick().catch(e => botLog("ERROR", `interval error: ${e.message}`));
    }, intervalMs);
  }
  return { applied, config: { ...botConfig } };
}

// Initialize on module load (don't await — runs in background)
refreshInstruments().then(async () => {
  try {
    const [eq] = await getEquity();
    equity_peak = eq;
    botLog("INFO", `Bot module initialized. Equity: ${eq} USDT`);
  } catch (e: any) {
    botLog("ERROR", `Init equity fetch failed: ${e.message}`);
  }
}).catch(e => botLog("ERROR", `Init instruments fetch failed: ${e.message}`));
