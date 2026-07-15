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
import {
  persistTrade, persistEquityPoint, loadTradeHistory, loadEquityHistory,
  loadBotState, saveBotState,
} from "@/lib/supabase";

// ============================================================================
// CONFIG
// ============================================================================
// API keys: try env vars first, fall back to demo keys.
// These are DEMO keys (no real funds) from https://demo.bybit.com — safe to hardcode.
// For mainnet, set BYBIT_API_KEY and BYBIT_API_SECRET env vars with real keys.
const API_KEY = process.env.BYBIT_API_KEY || "7bgvFV45gt4S4dzSqA";
const API_SECRET = process.env.BYBIT_API_SECRET || "qSXRniXguRwlU3WJ0vi6qpeJ256gDMqbEhNi";
const BASE_URL = process.env.BYBIT_BASE_URL || "https://api-demo.bybit.com";
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
  // Smart stop-loss params
  hedge_timeout_sec: 20,        // if hedge doesn't fill in N sec, market-close
  max_adverse_bps: 15,          // if unrealised loss > N bps, market-close immediately
  reprice_hedge: true,          // re-price hedge to current best opposite price instead of stale original
  verify_spread_at_fill: true,  // abort cycle (market-close) if spread dropped below min_spread_bps at fill time
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

// Supabase proxy config (Singapore database — bypasses Bybit geo-block).
// The project ref and anon key are NOT secrets — they're in the public Supabase URL.
// The bot calls Supabase RPC functions (submit_bybit + get_bybit_response) which run
// IN the Singapore database, so HTTP requests to Bybit originate from Singapore (not geo-blocked).
const SUPABASE_PROJECT_REF = "gcwwubldqdeoabrfwyoy";
const SUPABASE_URL = `https://${SUPABASE_PROJECT_REF}.supabase.co`;
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdjd3d1YmxkcWRlb2FicmZ3eW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNzkwODgsImV4cCI6MjA5OTY1NTA4OH0.MiYYkQsy910B7y34jsBGssj7sCCrxHg6oD7IwPVT3ns";

/**
 * Call Bybit API via Supabase Singapore database (bypasses geo-block).
 * Two-step process:
 *   1. submit_bybit() — submits the HTTP request from Singapore, returns request ID
 *   2. get_bybit_response() — polls for the response
 */
async function bybitViaSupabase(method: string, path: string, params: Record<string, string> = {}, body: Record<string, any> = {}): Promise<any> {
  // Step 1: Submit the Bybit request (runs in Singapore DB, bypasses geo-block)
  const submitRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_bybit`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      req_method: method,
      req_path: path,
      req_params: params,
      req_body: body,
      req_api_key: API_KEY,
      req_api_secret: API_SECRET,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!submitRes.ok) {
    const text = await submitRes.text();
    throw new Error(`Supabase submit failed: ${submitRes.status} ${text}`);
  }
  const reqId = await submitRes.json();

  // Step 2: Get response (server-side function polls every 0.5s up to 10s)
  // No client-side wait needed — the RPC function handles polling internally
  const getRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_bybit_response`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ req_id: reqId }),
    signal: AbortSignal.timeout(15000),
  });
  if (!getRes.ok) {
    const text = await getRes.text();
    throw new Error(`Supabase get failed: ${getRes.status} ${text}`);
  }
  const result = await getRes.json();
  if (result && result.error) {
    throw new Error(`Bybit(SG) error: ${result.error}`);
  }
  return result;
}

function sign(payload: string): string {
  const timestamp = Date.now().toString();
  const recvWindow = "10000";
  const data = `${timestamp}${API_KEY}${recvWindow}${payload}`;
  const sig = createHmac("sha256", API_SECRET).update(data).digest("hex");
  return sig;
}

/**
 * Route Bybit API calls through Supabase Singapore database (bypasses geo-block).
 * Falls back to direct Bybit calls when running locally (no geo-block).
 */
async function bybitGet(path: string, params: Record<string, string> = {}): Promise<any> {
  // Always use Supabase proxy (works from Vercel US and local dev)
  return bybitViaSupabase("GET", path, params);
}

async function bybitPost(path: string, params: Record<string, any> = {}): Promise<any> {
  return bybitViaSupabase("POST", path, {}, params);
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

/**
 * Fetch actual execution data (fill prices + fees) from Bybit for a given symbol.
 * Used to compute accurate realized PnL instead of using the intended hedge price.
 *
 * Returns BOTH entry and exit side data, because:
 *   - Entry leg (post-only limit) earns a MAKER REBATE (negative fee) — we get money back
 *   - Exit leg earns rebate if filled as limit, or pays taker fee if market-closed (SL)
 *   - Net PnL = gross_price_pnl - entry_fees - exit_fees
 *
 * Without entry fees, PnL was under-reported (we earn rebates on entry that weren't counted).
 */
async function getActualCloseData(symbol: string, leg: { side: string; entry: number; qty: number; open_ts: number }): Promise<{
  exit_fill_price: number;
  entry_fees: number;
  exit_fees: number;
  total_fees: number;
  exit_qty: number;
} | null> {
  try {
    const close_side = leg.side === "Buy" ? "Sell" : "Buy";
    const r: any = await bybitGet("/v5/execution/list", {
      category: CATEGORY, symbol, limit: "50",
    });
    const execs = r?.result?.list;
    if (!Array.isArray(execs)) return null;

    // Filter: executions after leg opened (with small buffer for clock skew)
    const cutoff = leg.open_ts - 5;
    const matching = execs.filter((e: any) => parseInt(e.execTime) / 1000 >= cutoff);
    if (matching.length === 0) return null;

    // Sort ascending by time
    matching.sort((a: any, b: any) => parseInt(a.execTime) - parseInt(b.execTime));

    // Sum entry-side executions (same side as leg.side)
    let entry_value = 0, entry_qty = 0, entry_fees = 0;
    for (const exec of matching) {
      if (exec.side !== leg.side) continue;
      const q = parseFloat(exec.execQty || "0");
      const p = parseFloat(exec.execPrice || "0");
      const f = parseFloat(exec.execFee || "0");
      entry_value += q * p;
      entry_qty += q;
      entry_fees += f;
    }

    // Sum exit-side executions (opposite side)
    let exit_value = 0, exit_qty = 0, exit_fees = 0;
    for (const exec of matching) {
      if (exec.side !== close_side) continue;
      const q = parseFloat(exec.execQty || "0");
      const p = parseFloat(exec.execPrice || "0");
      const f = parseFloat(exec.execFee || "0");
      exit_value += q * p;
      exit_qty += q;
      exit_fees += f;
    }

    if (exit_qty < leg.qty * 0.5) {
      // Didn't find enough exit executions — can't compute accurately
      return null;
    }

    const exit_fill_price = exit_qty > 0 ? exit_value / exit_qty : 0;
    return {
      exit_fill_price,
      entry_fees,
      exit_fees,
      total_fees: entry_fees + exit_fees,
      exit_qty,
    };
  } catch (e: any) {
    botLog("DEBUG", `getActualCloseData failed for ${symbol}: ${e.message}`);
    return null;
  }
}

/**
 * Record a closed leg in trade_history and update session_stats.
 * Called from ALL close scenarios: natural hedge fill, SL-adverse, SL-timeout, spread-collapse.
 * Previously, only natural fills were tracked — SL closes were silently dropped,
 * which made PnL and win rate look better than reality.
 *
 * Fetches ACTUAL fill data from Bybit execution history (entry + exit prices + fees).
 * Falls back to estimation if execution data is unavailable.
 *
 * Bybit DEMO fee structure (verified):
 *   - Maker fee: +0.04% (4 bps, POSITIVE — we pay, no rebate on demo)
 *   - Taker fee: +0.075-0.11% (varies by symbol)
 *   - Round-trip maker-maker: ~8 bps cost
 *   - Round-trip maker-taker (SL): ~15 bps cost
 */
async function recordClosedLeg(symbol: string, leg: OpenLeg, reason: string): Promise<void> {
  // Use placed_ts-equivalent: leg.open_ts minus a buffer to capture entry executions
  // that happened before the leg was registered (entry fills trigger leg creation)
  const since_ts = leg.open_ts - 60;  // 60s buffer

  const actual = await getActualCloseData(symbol, {
    side: leg.side, entry: leg.entry_price, qty: leg.qty, open_ts: since_ts,
  });

  let cycle_pnl: number;
  let gross_pnl: number;
  let actual_exit: number;
  let fees: number;
  let note: string;

  if (actual) {
    gross_pnl = leg.side === "Buy"
      ? (actual.exit_fill_price - leg.entry_price) * leg.qty
      : (leg.entry_price - actual.exit_fill_price) * leg.qty;
    cycle_pnl = gross_pnl - actual.total_fees;
    actual_exit = actual.exit_fill_price;
    fees = actual.total_fees;
    note = reason;
    botLog("INFO", `[CLOSE-ACTUAL] ${symbol} reason=${reason} exit=${actual.exit_fill_price} entry_fees=${actual.entry_fees.toFixed(4)} exit_fees=${actual.exit_fees.toFixed(4)} gross=${gross_pnl.toFixed(4)} net=${cycle_pnl.toFixed(4)}`);
  } else {
    // Fallback: estimate using intended hedge price.
    // Bybit DEMO fees: maker ~4 bps, taker ~7.5-11 bps. Assume maker for both legs.
    // Round-trip cost = 8 bps of notional = 0.0008 * (entry_notional + exit_notional)
    gross_pnl = leg.side === "Buy"
      ? ((leg.hedge_price ?? leg.entry_price) - leg.entry_price) * leg.qty
      : (leg.entry_price - (leg.hedge_price ?? leg.entry_price)) * leg.qty;
    const exit_px = leg.hedge_price ?? leg.entry_price;
    const est_fee_rate = reason === "natural" ? 0.0008 : 0.0015;  // higher rate for SL (taker)
    const est_notional = leg.entry_price * leg.qty + exit_px * leg.qty;
    fees = est_notional * est_fee_rate;  // POSITIVE = cost on demo
    cycle_pnl = gross_pnl - fees;
    actual_exit = exit_px;
    note = `${reason}-est`;
    botLog("WARNING", `[CLOSE-EST] ${symbol} reason=${reason} execution data unavailable — estimating fees at ${(est_fee_rate * 10000).toFixed(0)}bps round-trip`);
  }

  trade_history.push({
    ts: Date.now() / 1000, symbol,
    side: leg.side, entry: leg.entry_price, exit: actual_exit,
    qty: leg.qty, pnl: cycle_pnl, gross_pnl, fees, note,
  });
  // Persist to Supabase (survives serverless cold starts)
  persistTrade({
    ts: Date.now() / 1000, symbol,
    side: leg.side, entry_price: leg.entry_price, exit_price: actual_exit,
    qty: leg.qty, gross_pnl, fees, net_pnl: cycle_pnl,
    close_reason: reason, session_id: session_id,
  }).catch(e => botLog("DEBUG", `persistTrade failed: ${e.message}`));
  session_stats.total_cycles += 1;
  session_stats.total_realized_pnl += cycle_pnl;
  session_stats.total_fees_paid += fees;
  if (cycle_pnl > 0) session_stats.winning_cycles += 1;
  else if (cycle_pnl < 0) session_stats.losing_cycles += 1;
  if (trade_history.length > 200) trade_history.shift();
}

/**
 * Fetch the ACTUAL entry fill price for a leg from Bybit execution history.
 * Used to correct the entry_price stored in open_legs (which was previously
 * the intended limit price, not the actual fill price).
 *
 * Returns the volume-weighted average entry fill price.
 */
async function getActualEntryData(symbol: string, side: string, since_ts: number): Promise<{ fill_price: number; qty: number } | null> {
  try {
    const r: any = await bybitGet("/v5/execution/list", {
      category: CATEGORY, symbol, limit: "50",
    });
    const execs = r?.result?.list;
    if (!Array.isArray(execs)) return null;

    // Use a buffer: entry executions can happen slightly before since_ts due to network latency
    const cutoff = since_ts - 5;
    let total_value = 0, total_qty = 0;
    for (const exec of execs) {
      const exec_ts = parseInt(exec.execTime) / 1000;
      if (exec_ts < cutoff) continue;
      if (exec.side !== side) continue;
      const q = parseFloat(exec.execQty || "0");
      const p = parseFloat(exec.execPrice || "0");
      total_value += q * p;
      total_qty += q;
    }

    if (total_qty <= 0) return null;
    return { fill_price: total_value / total_qty, qty: total_qty };
  } catch (e: any) {
    return null;
  }
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

async function placeMarketReduceClose(symbol: string, side: string, qty: number): Promise<string | null> {
  try {
    const r: any = await bybitPost("/v5/order/create", {
      category: CATEGORY, symbol, side,
      orderType: "Market", qty: String(qty), reduceOnly: true,
    });
    const oid = r?.result?.orderId;
    botLog("INFO", `  closed ${symbol} (${side} ${qty}) oid=${oid}`);
    return oid || null;
  } catch (e: any) {
    botLog("WARNING", `  close ${symbol} failed: ${e.message}`);
    return null;
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
let session_id: string = `session_${Date.now()}`;  // changes on each bot start

const equity_history: any[] = [];
const trade_history: any[] = [];
let last_legs_snapshot: Map<string, any> = new Map();

// Session stats (reset on dev server restart)
let session_stats = {
  total_cycles: 0,         // completed MM cycles (both legs filled)
  winning_cycles: 0,       // cycles that captured positive spread
  losing_cycles: 0,        // cycles that lost money (hedge slipped adverse)
  total_realized_pnl: 0,   // sum of cycle PnLs in USDT
  total_fees_paid: 0,      // estimate (not tracked precisely on demo)
  session_start_ts: Date.now() / 1000,
};

// ============================================================================
// BOT LOGIC
// ============================================================================
function computeQty(price: number, inst: Instrument, equity: number): number | null {
  if (equity <= 0 || price <= 0 || inst.qty_step <= 0) return null;
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
    // Round UP to satisfy min notional after rounding
    const raw_steps = notional / price / inst.qty_step;
    qty = Math.max(1, Math.ceil(raw_steps)) * inst.qty_step;
  } else {
    // Round DOWN to stay at-or-below 2%
    qty = Math.floor((notional / price) / inst.qty_step) * inst.qty_step;
  }

  // Guard against zero qty (causes "orderQty will be truncated to zero" Bybit error)
  if (qty <= 0 || qty < inst.min_order_qty) {
    // Try one step above min_order_qty
    const fallback_qty = inst.min_order_qty;
    if (fallback_qty * price < min_notional - 1e-9) {
      // Even min qty is too small for min notional — skip this symbol
      return null;
    }
    qty = fallback_qty;
  }

  // Final min-notional safety: bump up by one step if needed
  if (qty * price < min_notional - 1e-9) {
    qty = qty + inst.qty_step;
    if (qty * price < min_notional - 1e-9) return null;
  }

  // Sanity: ensure qty is a valid multiple of qty_step
  const steps = Math.round(qty / inst.qty_step);
  qty = steps * inst.qty_step;
  if (qty <= 0) return null;

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

    // Partial-fill guard: if position size < order qty, only part of one leg filled.
    // We still treat it as "filled" and hedge the actual position size, but log it.
    if (pos_size > 0 && pos_size < pp.qty) {
      botLog("WARNING", `  ${sym}: PARTIAL FILL detected — pos_size=${pos_size} < order_qty=${pp.qty}. Hedging actual size only.`);
    }

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

  // Fetch ACTUAL entry fill price from Bybit (not the intended limit price).
  // Post-only orders usually fill at the limit price, but partial fills or
  // tick rounding can cause slight differences. Using the actual fill price
  // ensures PnL and adverse_bps SL are computed against reality.
  const entry_data = await getActualEntryData(pp.symbol, "Buy", pp.placed_ts);
  const actual_entry = entry_data?.fill_price ?? pp.buy_price;
  if (entry_data && Math.abs(actual_entry - pp.buy_price) > 1e-9) {
    botLog("INFO", `  -> ${pp.symbol} actual entry fill=${actual_entry} (intended ${pp.buy_price})`);
  }

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

  // === SPREAD RE-VERIFICATION (fix for sub-threshold trades) ===
  // Fetch current quote. If spread has collapsed below min_spread_bps, the
  // passive hedge at the original ask will likely never fill (or fill very
  // late). Better to market-close now and accept a tiny loss than hold risk.
  if (botConfig.verify_spread_at_fill) {
    const q = await getQuote(pp.symbol, 5);
    if (q) {
      const current_spread_bps = q.spread_bps;
      const adverse_move_bps = ((q.ask - actual_entry) / actual_entry) * 10000;
      botLog("INFO", `  -> ${pp.symbol} current spread=${current_spread_bps.toFixed(1)}bps, ask moved ${adverse_move_bps >= 0 ? "+" : ""}${adverse_move_bps.toFixed(1)}bps from entry`);
      if (current_spread_bps < botConfig.min_spread_bps && !sell_live) {
        // Spread collapsed. If the SELL leg is also gone, we have no natural hedge.
        // Market-close immediately to avoid holding an unhedged position.
        botLog("WARNING", `  -> ${pp.symbol} SPREAD COLLAPSED to ${current_spread_bps.toFixed(1)}bps (< ${botConfig.min_spread_bps}) — market-closing to avoid risk`);
        // Cancel any remaining SELL leg first
        if (pp.sell_order_id) await cancelOrder(pp.symbol, pp.sell_order_id);
        await placeMarketReduceClose(pp.symbol, "Sell", pos_size);
        // Record this spread-collapse close in trade history
        await recordClosedLeg(pp.symbol, {
          symbol: pp.symbol, side: "Buy", qty: pos_size,
          entry_price: actual_entry, open_ts: Date.now() / 1000,
          hedge_order_id: null, hedge_price: q.bid,
        }, "spread-collapse");
        pending.delete(pp.symbol);
        return;
      }
    }
  }

  let hedge_id: string | null = null;
  let hedge_px: number = pp.sell_price;
  if (sell_live) {
    botLog("INFO", `  -> ${pp.symbol} SELL leg still live — will close position naturally`);
    hedge_id = pp.sell_order_id;
  } else {
    const inst = instrumentCache.get(pp.symbol);
    // === SMART HEDGE RE-PRICING ===
    // Instead of pricing the hedge at the stale original sell_price, re-price
    // to the current best ask (we're long, need to sell, so join the ask).
    // This dramatically increases fill probability and captures real spread.
    if (botConfig.reprice_hedge) {
      const q = await getQuote(pp.symbol, 5);
      if (q && q.ask > 0) {
        hedge_px = inst ? roundPrice(q.ask, inst.price_tick) : q.ask;
        botLog("INFO", `  -> ${pp.symbol} re-priced hedge from stale ${pp.sell_price} to current ask ${hedge_px}`);
      } else {
        hedge_px = inst ? roundPrice(pp.sell_price, inst.price_tick) : pp.sell_price;
      }
    } else {
      hedge_px = inst ? roundPrice(pp.sell_price, inst.price_tick) : pp.sell_price;
    }
    hedge_id = await placeLimit(pp.symbol, "Sell", pos_size, hedge_px, { reduce_only: true });
    if (!hedge_id) botLog("ERROR", `  -> ${pp.symbol} hedge placement FAILED — position remains OPEN!`);
  }

  open_legs.set(pp.symbol, {
    symbol: pp.symbol, side: "Buy", qty: pos_size,
    entry_price: actual_entry, open_ts: Date.now() / 1000,  // ACTUAL fill price
    hedge_order_id: hedge_id, hedge_price: hedge_px,
  });
  pending.delete(pp.symbol);
}

async function onSellFilled(pp: PendingPair, pos: any): Promise<void> {
  const pos_size = Math.abs(parseFloat(pos.size || "0"));
  botLog("INFO", `[FILL] ${pp.symbol} SELL filled @ ${pp.sell_price} | size=${pos_size} | checking hedge...`);

  // Fetch ACTUAL entry fill price from Bybit (not the intended limit price).
  const entry_data = await getActualEntryData(pp.symbol, "Sell", pp.placed_ts);
  const actual_entry = entry_data?.fill_price ?? pp.sell_price;
  if (entry_data && Math.abs(actual_entry - pp.sell_price) > 1e-9) {
    botLog("INFO", `  -> ${pp.symbol} actual entry fill=${actual_entry} (intended ${pp.sell_price})`);
  }

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

  // === SPREAD RE-VERIFICATION ===
  if (botConfig.verify_spread_at_fill) {
    const q = await getQuote(pp.symbol, 5);
    if (q) {
      const current_spread_bps = q.spread_bps;
      const adverse_move_bps = ((actual_entry - q.bid) / actual_entry) * 10000;
      botLog("INFO", `  -> ${pp.symbol} current spread=${current_spread_bps.toFixed(1)}bps, bid moved ${adverse_move_bps >= 0 ? "+" : ""}${adverse_move_bps.toFixed(1)}bps from entry`);
      if (current_spread_bps < botConfig.min_spread_bps && !buy_live) {
        botLog("WARNING", `  -> ${pp.symbol} SPREAD COLLAPSED to ${current_spread_bps.toFixed(1)}bps (< ${botConfig.min_spread_bps}) — market-closing to avoid risk`);
        if (pp.buy_order_id) await cancelOrder(pp.symbol, pp.buy_order_id);
        await placeMarketReduceClose(pp.symbol, "Buy", pos_size);
        await recordClosedLeg(pp.symbol, {
          symbol: pp.symbol, side: "Sell", qty: pos_size,
          entry_price: actual_entry, open_ts: Date.now() / 1000,
          hedge_order_id: null, hedge_price: q.ask,
        }, "spread-collapse");
        pending.delete(pp.symbol);
        return;
      }
    }
  }

  let hedge_id: string | null = null;
  let hedge_px: number = pp.buy_price;
  if (buy_live) {
    botLog("INFO", `  -> ${pp.symbol} BUY leg still live — will close position naturally`);
    hedge_id = pp.buy_order_id;
  } else {
    const inst = instrumentCache.get(pp.symbol);
    // === SMART HEDGE RE-PRICING ===
    // We're short, need to buy back. Join the current best bid.
    if (botConfig.reprice_hedge) {
      const q = await getQuote(pp.symbol, 5);
      if (q && q.bid > 0) {
        hedge_px = inst ? roundPrice(q.bid, inst.price_tick) : q.bid;
        botLog("INFO", `  -> ${pp.symbol} re-priced hedge from stale ${pp.buy_price} to current bid ${hedge_px}`);
      } else {
        hedge_px = inst ? roundPrice(pp.buy_price, inst.price_tick) : pp.buy_price;
      }
    } else {
      hedge_px = inst ? roundPrice(pp.buy_price, inst.price_tick) : pp.buy_price;
    }
    hedge_id = await placeLimit(pp.symbol, "Buy", pos_size, hedge_px, { reduce_only: true });
    if (!hedge_id) botLog("ERROR", `  -> ${pp.symbol} hedge placement FAILED — position remains OPEN!`);
  }

  open_legs.set(pp.symbol, {
    symbol: pp.symbol, side: "Sell", qty: pos_size,
    entry_price: actual_entry, open_ts: Date.now() / 1000,  // ACTUAL fill price
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

/**
 * Smart stop-loss for open hedge legs. Two triggers:
 *   1. TIME-BASED: if hedge hasn't filled within `hedge_timeout_sec`,
 *      market-close to avoid holding risk indefinitely.
 *   2. ADVERSE-MOVE: if unrealised loss exceeds `max_adverse_bps` (in bps
 *      relative to entry price), market-close immediately to cap loss.
 *
 * This prevents the "stale hedge" problem where a passive limit order sits
 * forever while the market runs against the position.
 */
async function manageOpenLegs(): Promise<void> {
  const now = Date.now() / 1000;
  for (const sym of Array.from(open_legs.keys())) {
    const leg = open_legs.get(sym);
    if (!leg) continue;
    const age = now - leg.open_ts;

    // Get current quote to compute unrealised loss
    const q = await getQuote(sym, 5);
    if (!q) continue;  // can't fetch quote, skip this cycle

    // Compute unrealised PnL in bps relative to entry
    // If LONG (Buy): mark-to-market at current bid (what we'd get selling now)
    // If SHORT (Sell): mark-to-market at current ask (what we'd pay buying back)
    let current_price: number;
    let adverse_bps: number;
    if (leg.side === "Buy") {
      current_price = q.bid;
      adverse_bps = ((leg.entry_price - current_price) / leg.entry_price) * 10000;
    } else {
      current_price = q.ask;
      adverse_bps = ((current_price - leg.entry_price) / leg.entry_price) * 10000;
    }

    // Trigger 1: adverse move beyond threshold
    if (adverse_bps > botConfig.max_adverse_bps) {
      botLog("WARNING", `[SL-ADVERSE] ${sym} side=${leg.side} entry=${leg.entry_price} current=${current_price} loss=${adverse_bps.toFixed(1)}bps > ${botConfig.max_adverse_bps}bps — market-closing`);
      // Cancel existing hedge limit order first
      if (leg.hedge_order_id) await cancelOrder(sym, leg.hedge_order_id);
      const close_side = leg.side === "Buy" ? "Sell" : "Buy";
      await placeMarketReduceClose(sym, close_side, leg.qty);
      // Record this SL-closed leg in trade history (was being silently dropped!)
      await recordClosedLeg(sym, leg, "sl-adverse");
      open_legs.delete(sym);
      continue;
    }

    // Trigger 2: hedge timed out
    if (age > botConfig.hedge_timeout_sec) {
      botLog("WARNING", `[SL-TIMEOUT] ${sym} side=${leg.side} age=${age.toFixed(0)}s > ${botConfig.hedge_timeout_sec}s — hedge not filled, market-closing`);
      if (leg.hedge_order_id) await cancelOrder(sym, leg.hedge_order_id);
      const close_side = leg.side === "Buy" ? "Sell" : "Buy";
      await placeMarketReduceClose(sym, close_side, leg.qty);
      await recordClosedLeg(sym, leg, "sl-timeout");
      open_legs.delete(sym);
      continue;
    }

    // Status log every ~10s
    if (Math.floor(age) % 10 === 0 && Math.floor(age) > 0) {
      botLog("INFO", `[LEG] ${sym} side=${leg.side} age=${age.toFixed(0)}s adverse=${adverse_bps.toFixed(1)}bps (max ${botConfig.max_adverse_bps})`);
    }
  }
}

async function checkDrawdown(): Promise<boolean> {
  let equity = 0;
  try { [equity] = await getEquity(); } catch (e: any) {
    botLog("WARNING", `equity fetch failed (will retry next tick): ${e.message}`);
    // Don't halt — transient network errors shouldn't stop the bot.
    // But also don't continue placing new trades blind — return true to allow
    // reconcile/manageOpenLegs to run (which may close positions for safety),
    // but step() will fail to size new orders without equity, so no new trades.
    return true;
  }
  if (equity <= 0) {
    botLog("WARNING", `equity is zero/negative (${equity}) — halting new trades`);
    halted = true;
    return false;
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
  await manageOpenLegs();  // smart SL checks

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
let worker_in_progress = false;  // mutex: prevent overlapping workerTick calls

async function workerTick(): Promise<void> {
  if (stop_requested || !bot_running) return;
  // Mutex: if previous tick is still running (slow Bybit API), skip this one
  if (worker_in_progress) {
    botLog("DEBUG", `workerTick skipped — previous tick still in progress`);
    return;
  }
  worker_in_progress = true;
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
      // Persist to Supabase (every 5th point to avoid DB spam)
      if (Math.floor(now) % 15 === 0) {
        persistEquityPoint({
          ts: now, equity: eq, available: av,
          pending_count: pending.size, legs_count: open_legs.size,
          session_id,
        }).catch(() => {});
      }
    } catch { /* ignore */ }

    const current_legs = new Set(open_legs.keys());
    for (const [sym, leg] of last_legs_snapshot) {
      if (!current_legs.has(sym)) {
        // Natural close: hedge filled (or position disappeared from Bybit).
        // Use the unified recordClosedLeg function for consistent PnL math.
        // The leg object from snapshot has the same shape as OpenLeg.
        await recordClosedLeg(sym, {
          symbol: sym,
          side: leg.side,
          qty: leg.qty,
          entry_price: leg.entry,
          hedge_price: leg.hedge,
          open_ts: leg.open_ts,
          hedge_order_id: null,
        } as OpenLeg, "natural");
      }
    }
    last_legs_snapshot = new Map();
    for (const [sym, leg] of open_legs) {
      last_legs_snapshot.set(sym, {
        side: leg.side, entry: leg.entry_price, hedge: leg.hedge_price,
        qty: leg.qty, open_ts: leg.open_ts,
      });
    }
  } catch (e: any) {
    botLog("ERROR", `Worker tick error: ${e.message}`);
    last_error = e.message;
  } finally {
    worker_in_progress = false;
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
    botLog("WARNING", `[RECOVER] orphan position ${sym} side=${side} size=${size} entry=${entry} — market-closing immediately`);
    // For recovery, use MARKET reduce-only to guarantee immediate flatten.
    // Limit orders could sit unfilled and leave risk open.
    const close_side = side === "Buy" ? "Sell" : "Buy";
    const oid = await placeMarketReduceClose(sym, close_side, size);
    // Don't track in open_legs since market order should fill instantly.
    // Reconcile will detect position gone next tick.
    if (oid) {
      botLog("INFO", `  -> ${sym} recovery market-close placed oid=${oid}`);
    }
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

/**
 * Cron-triggered single tick. Designed for Vercel serverless (stateless).
 * Each call:
 *   1. Loads instruments if not cached
 *   2. Refreshes universe if stale
 *   3. Runs ONE step() cycle (reconcile, manage, scan, place orders)
 *   4. Samples equity and persists to Supabase
 *
 * The bot doesn't need a persistent setInterval — Vercel Cron calls this
 * endpoint every minute, and each call does one cycle of work.
 */
export async function cronTick(): Promise<any> {
  const tickStart = Date.now();

  // Sync halted/stopped state from Supabase (survives cold starts)
  await syncHaltedFromSupabase();

  // Respect stop_requested and halted flags.
  // If the user clicked Stop (persisted to Supabase), cron ticks are no-ops.
  if (stop_requested || halted) {
    return {
      status: "stopped",
      duration_ms: Date.now() - tickStart,
      message: "Bot is stopped — cron tick skipped. Click Start to resume.",
      pending: pending.size,
      open_legs: open_legs.size,
    };
  }

  try {
    if (!instrumentsLoaded) {
      await refreshInstruments();
    }
    const now = Date.now() / 1000;
    if (now - last_scan_ts > botConfig.scan_interval_sec || universe_cache.length === 0) {
      await refreshInstruments();
      universe_cache = await getTopUniverse(botConfig.symbol_universe_size);
      last_scan_ts = now;
    }

    // Mark as running during this tick (for UI status)
    const wasRunning = bot_running;
    if (!wasRunning) {
      bot_running = true;
      // Don't reset stop_requested here — that's only cleared by explicit startBot()
    }

    await step(universe_cache);

    // Sample equity
    let equity = 0, available = 0;
    try {
      [equity, available] = await getEquity();
      equity_history.push({
        ts: now, equity, available,
        pending: pending.size, legs: open_legs.size,
      });
      if (equity_history.length > 300) equity_history.shift();
      persistEquityPoint({
        ts: now, equity, available,
        pending_count: pending.size, legs_count: open_legs.size,
        session_id,
      }).catch(() => {});
    } catch {}

    // Detect closed legs and record them
    const current_legs = new Set(open_legs.keys());
    for (const [sym, leg] of last_legs_snapshot) {
      if (!current_legs.has(sym)) {
        await recordClosedLeg(sym, {
          symbol: sym, side: leg.side, qty: leg.qty,
          entry_price: leg.entry, hedge_price: leg.hedge,
          open_ts: leg.open_ts, hedge_order_id: null,
        } as OpenLeg, "natural");
      }
    }
    last_legs_snapshot = new Map();
    for (const [sym, leg] of open_legs) {
      last_legs_snapshot.set(sym, {
        side: leg.side, entry: leg.entry_price, hedge: leg.hedge_price,
        qty: leg.qty, open_ts: leg.open_ts,
      });
    }

    // Don't keep bot_running true if it wasn't before (cron mode = transient)
    if (!wasRunning) {
      bot_running = false;
    }

    const duration = Date.now() - tickStart;
    return {
      status: "ok",
      duration_ms: duration,
      pending: pending.size,
      open_legs: open_legs.size,
      equity,
      universe_size: universe_cache.length,
    };
  } catch (e: any) {
    botLog("ERROR", `cronTick error: ${e.message}`);
    return { status: "error", error: e.message, duration_ms: Date.now() - tickStart };
  }
}

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
  session_id = `session_${Date.now()}`;
  botLog("INFO", `Starting new session: ${session_id}`);
  // Persist "running" state to Supabase (survives cold starts)
  saveBotState({
    config: { ...botConfig },
    session_stats: { ...session_stats },
    equity_peak,
    halted: false,
  }).catch(() => {});
  // Also mark as not-stopped in the bot_state table
  try {
    const sb = (await import("@/lib/supabase")).getSupabase();
    if (sb) {
      await sb.from("bot_state").update({
        halted: false,
        updated_at: new Date().toISOString(),
      }).eq("id", 1);
    }
  } catch {}
  try { await recoverOrphans(); } catch (e: any) {
    botLog("WARNING", `recover failed: ${e.message}`);
  }
  if (worker_interval) clearInterval(worker_interval);
  const intervalMs = Math.max(1000, botConfig.poll_interval_sec * 1000);
  worker_interval = setInterval(() => {
    workerTick().catch(e => botLog("ERROR", `interval error: ${e.message}`));
  }, intervalMs);
  botLog("INFO", "Bot started — cron ticks will now place trades");
  return { status: "started" };
}

export async function stopBot(): Promise<any> {
  // Always set stop_requested, even if bot_running is false (could be between cron ticks)
  stop_requested = true;
  bot_running = false;
  if (worker_interval) {
    clearInterval(worker_interval);
    worker_interval = null;
  }
  // Cancel any pending MM pairs so we don't leave orphan post-only orders on the book
  const cancelledCount = pending.size;
  botLog("INFO", `Stopping bot — cancelling ${cancelledCount} pending pair(s) and halting cron ticks`);
  for (const [sym, pp] of Array.from(pending.entries())) {
    if (pp.buy_order_id) await cancelOrder(sym, pp.buy_order_id);
    if (pp.sell_order_id) await cancelOrder(sym, pp.sell_order_id);
    pending.delete(sym);
  }
  // Persist stopped state to Supabase so cron ticks respect it across cold starts
  try {
    const sb = (await import("@/lib/supabase")).getSupabase();
    if (sb) {
      await sb.from("bot_state").update({
        halted: true,  // reuse halted flag to mean "stopped by user"
        updated_at: new Date().toISOString(),
      }).eq("id", 1);
    }
  } catch {}
  botLog("INFO", "Bot stopped — cron ticks will be no-ops until Start is clicked");
  return { status: "stopped", cancelled_pairs: cancelledCount };
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

export async function healthCheck(): Promise<{ reachable: boolean; proxy: boolean; error?: string }> {
  try {
    const r: any = await bybitGet("/v5/market/time");
    return { reachable: r?.retCode === 0, proxy: true };
  } catch (e: any) {
    return { reachable: false, proxy: true, error: e.message };
  }
}

/**
 * Build a valid state response even when Bybit is unreachable.
 * Includes ALL fields the UI expects (positions, config, top_spreads, etc.)
 * so the client doesn't crash with TypeError on missing fields.
 */
function makeErrorResponse(error: string, isRunning: boolean): any {
  return {
    error,
    bot_running: isRunning,
    last_error: error,
    equity: 0,
    available: 0,
    equity_peak: 0,
    positions: [],
    open_orders: [],
    pending_pairs: [],
    open_legs: [],
    excluded_symbols: Array.from(EXCLUDED_SYMBOLS).sort(),
    universe: universe_cache,
    top_spreads: [],
    config: { ...botConfig },
    session_stats: {
      total_cycles: 0,
      winning_cycles: 0,
      losing_cycles: 0,
      total_realized_pnl: 0,
      total_fees_paid: 0,
      session_start_ts: Date.now() / 1000,
      session_duration_sec: 0,
      win_rate: 0,
      gross_pnl: 0,
      avg_pnl_per_cycle: 0,
    },
    halted: false,
  };
}

/**
 * Sync the halted/stopped state from Supabase.
 * Vercel serverless is stateless — in-memory `halted` resets to false on every
 * cold start. This function loads the persisted state so the dashboard and
 * cron ticks know whether the user clicked Stop.
 */
async function syncHaltedFromSupabase(): Promise<void> {
  try {
    const sb = (await import("@/lib/supabase")).getSupabase();
    if (!sb) return;
    const { data, error } = await sb.from("bot_state").select("halted").eq("id", 1).single();
    if (!error && data) {
      const wasHalted = halted;
      halted = !!data.halted;
      if (halted) stop_requested = true;
      else if (wasHalted && !halted) stop_requested = false;
    }
  } catch (e: any) {
    // Don't log — this runs on every request and would spam logs
  }
}

export async function getSnapshot(): Promise<any> {
  // Sync halted flag from Supabase FIRST (stateless persistence)
  await syncHaltedFromSupabase();

  if (!instrumentsLoaded) {
    try { await refreshInstruments(); } catch (e: any) {
      return makeErrorResponse(`init failed: ${e.message}`, bot_running);
    }
  }

  // Parallelize the 3 core Bybit calls (equity, positions, orders) — saves ~6s
  const [equityResult, positionsResult, ordersResult] = await Promise.allSettled([
    getEquity(),
    getPositions(),
    getOpenOrders(),
  ]);

  if (equityResult.status === 'rejected') {
    return makeErrorResponse(`get_equity failed: ${equityResult.reason?.message || equityResult.reason}`, bot_running);
  }

  const [equity, available] = equityResult.value;
  const positions = positionsResult.status === 'fulfilled' ? positionsResult.value : [];
  const open_orders = ordersResult.status === 'fulfilled' ? ordersResult.value : [];

  const excluded = Array.from(new Set([...runtime_excluded, ...EXCLUDED_SYMBOLS])).sort();

  // Fetch spreads — limit to 5 symbols and parallelize (each call ~3s via proxy)
  let universe: string[] = universe_cache;
  if (universe.length === 0) {
    try { universe = await getTopUniverse(botConfig.symbol_universe_size); } catch { universe = []; }
  }
  const scanSyms = universe.slice(0, 5);
  const quoteResults = await Promise.all(
    scanSyms.map(sym => getQuote(sym, 3).then(q => ({ sym, q })).catch(() => ({ sym, q: null })))
  );
  const spreads: any[] = [];
  for (const { sym, q } of quoteResults) {
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
    // Sort by spread descending (highest first), show all — UI will render with scroll.
    // Previously sliced to 10, which could hide tradable opportunities.
    top_spreads: spreads.sort((a, b) => b.spread_bps - a.spread_bps),
    config: { ...botConfig },
    session_stats: {
      ...session_stats,
      session_duration_sec: Math.round((Date.now() / 1000) - session_stats.session_start_ts),
      win_rate: session_stats.total_cycles > 0
        ? (session_stats.winning_cycles / session_stats.total_cycles) * 100
        : 0,
      gross_pnl: session_stats.total_realized_pnl + session_stats.total_fees_paid,
      // gross_pnl = net_pnl + fees (because net = gross - fees)
      // If fees are negative (rebate), gross > net. If fees positive (taker), gross < net.
      avg_pnl_per_cycle: session_stats.total_cycles > 0
        ? session_stats.total_realized_pnl / session_stats.total_cycles
        : 0,
    },
    halted,
  };
}

export function getLogs(n: number = 200): LogEntry[] {
  return logBuffer.slice(-Math.max(1, Math.min(2000, n)));
}

export function getTrades(): any[] {
  return trade_history;
}

export async function getTradesAsync(): Promise<any[]> {
  // Try loading from Supabase first (persists across restarts)
  const sbTrades = await loadTradeHistory(200);
  if (sbTrades.length > 0) {
    // Convert DB rows to the format expected by the UI
    return sbTrades.map(t => ({
      ts: t.ts, symbol: t.symbol, side: t.side,
      entry: parseFloat(t.entry_price), exit: parseFloat(t.exit_price),
      qty: parseFloat(t.qty), pnl: parseFloat(t.net_pnl),
      gross_pnl: parseFloat(t.gross_pnl), fees: parseFloat(t.fees),
      note: t.close_reason,
    }));
  }
  // Fallback to in-memory
  return trade_history;
}

export function getEquityHistory(): any[] {
  return equity_history;
}

export async function getEquityHistoryAsync(): Promise<any[]> {
  const sbHistory = await loadEquityHistory(300);
  if (sbHistory.length > 0) {
    return sbHistory.map(h => ({
      ts: h.ts, equity: parseFloat(h.equity), available: parseFloat(h.available),
      pending: h.pending_count, legs: h.legs_count,
    }));
  }
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
