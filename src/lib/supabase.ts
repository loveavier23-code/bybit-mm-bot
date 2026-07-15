/**
 * Supabase client for data persistence.
 *
 * Uses the service_role key (server-side only) to bypass RLS for bot operations.
 * The bot persists trades, equity history, and bot state here so data survives
 * serverless function cold starts and deployments.
 *
 * Tables:
 *   - trades: completed MM cycles with PnL/fees
 *   - equity_history: sampled equity curve
 *   - bot_state: config + session stats
 *   - open_legs: currently unhedged positions (crash recovery)
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return null;
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export interface TradeRow {
  ts: number;
  symbol: string;
  side: string;
  entry_price: number;
  exit_price: number;
  qty: number;
  gross_pnl: number;
  fees: number;
  net_pnl: number;
  close_reason: string;
  session_id?: string;
}

export interface EquityRow {
  ts: number;
  equity: number;
  available: number;
  pending_count: number;
  legs_count: number;
  session_id?: string;
}

export async function persistTrade(trade: TradeRow): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { error } = await sb.from("trades").insert(trade);
    if (error) console.error("[supabase] persistTrade error:", error.message);
  } catch (e: any) {
    console.error("[supabase] persistTrade exception:", e.message);
  }
}

export async function persistEquityPoint(point: EquityRow): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { error } = await sb.from("equity_history").insert(point);
    if (error) console.error("[supabase] persistEquityPoint error:", error.message);
  } catch (e: any) {
    console.error("[supabase] persistEquityPoint exception:", e.message);
  }
}

export async function loadTradeHistory(limit: number = 200): Promise<any[]> {
  const sb = getSupabase();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("trades")
      .select("*")
      .order("ts", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[supabase] loadTradeHistory error:", error.message);
      return [];
    }
    return data || [];
  } catch (e: any) {
    console.error("[supabase] loadTradeHistory exception:", e.message);
    return [];
  }
}

export async function loadEquityHistory(limit: number = 300): Promise<any[]> {
  const sb = getSupabase();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("equity_history")
      .select("*")
      .order("ts", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[supabase] loadEquityHistory error:", error.message);
      return [];
    }
    return (data || []).reverse(); // return oldest-first for charting
  } catch (e: any) {
    console.error("[supabase] loadEquityHistory exception:", e.message);
    return [];
  }
}

export async function loadBotState(): Promise<any | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("bot_state")
      .select("*")
      .eq("id", 1)
      .single();
    if (error) {
      console.error("[supabase] loadBotState error:", error.message);
      return null;
    }
    return data;
  } catch (e: any) {
    console.error("[supabase] loadBotState exception:", e.message);
    return null;
  }
}

export async function saveBotState(state: {
  config: any;
  session_stats: any;
  equity_peak: number;
  halted: boolean;
}): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { error } = await sb
      .from("bot_state")
      .upsert({
        id: 1,
        config: state.config,
        session_stats: state.session_stats,
        equity_peak: state.equity_peak,
        halted: state.halted,
        updated_at: new Date().toISOString(),
      });
    if (error) console.error("[supabase] saveBotState error:", error.message);
  } catch (e: any) {
    console.error("[supabase] saveBotState exception:", e.message);
  }
}
