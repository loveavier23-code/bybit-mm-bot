/**
 * Tiny fetch helper for talking to the Python FastAPI bridge.
 *
 * The browser can't reach localhost:8000 directly (it's not exposed through
 * the gateway). Instead, we route all calls through a Next.js catch-all
 * proxy at /api/bot/* which forwards server-side to the bridge.
 */

function buildUrl(path: string): string {
  // Strip leading slash for clean join
  const clean = path.replace(/^\/+/, "");
  return `/api/bot/${clean}`;
}

export async function api<T = any>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(buildUrl(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
    // Always fetch fresh data
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Types -----------------------------------------------------------------------

export interface BotState {
  bot_running: boolean;
  last_error: string | null;
  equity: number;
  available: number;
  equity_peak: number;
  positions: Position[];
  open_orders: OpenOrder[];
  pending_pairs: PendingPair[];
  open_legs: OpenLeg[];
  excluded_symbols: string[];
  universe: string[];
  top_spreads: SpreadOp[];
  config: BotConfig;
  session_stats?: SessionStats;
  halted?: boolean;
}

export interface SessionStats {
  total_cycles: number;
  winning_cycles: number;
  losing_cycles: number;
  total_realized_pnl: number;
  total_fees_paid: number;
  session_start_ts: number;
  session_duration_sec: number;
  win_rate: number;
}

export interface Position {
  symbol: string;
  side: string;
  size: number;
  entry_price: number;
  unrealised_pnl: number;
  leverage: string;
  margin: number;
}

export interface OpenOrder {
  symbol: string;
  side: string;
  qty: number;
  price: number;
  type: string;
  reduce_only: boolean;
  status: string;
  created_at: string;
}

export interface PendingPair {
  symbol: string;
  buy_price: number;
  sell_price: number;
  qty: number;
  age_sec: number;
}

export interface OpenLeg {
  symbol: string;
  side: string;
  qty: number;
  entry_price: number;
  hedge_price: number;
  age_sec: number;
}

export interface SpreadOp {
  symbol: string;
  bid: number;
  ask: number;
  spread_bps: number;
  mid: number;
}

export interface BotConfig {
  per_trade_margin_pct: number;
  leverage: number;
  max_concurrent_symbols: number;
  min_spread_bps: number;
  target_capture_bps: number;
  order_timeout_sec: number;
  poll_interval_sec: number;
  scan_interval_sec: number;
  max_drawdown_pct: number;
  symbol_universe_size: number;
  auto_min_notional: boolean;
  min_notional_usdt: number;
  // Smart SL params
  hedge_timeout_sec: number;
  max_adverse_bps: number;
  reprice_hedge: boolean;
  verify_spread_at_fill: boolean;
}

export interface LogEntry {
  ts: number;
  level: string;
  msg: string;
}

export interface EquityPoint {
  ts: number;
  equity: number;
  available: number;
  pending: number;
  legs: number;
}

export interface Trade {
  ts: number;
  symbol: string;
  side: string;
  entry: number;
  exit: number;
  qty: number;
  pnl?: number;
  fees?: number;
  note: string;
}
