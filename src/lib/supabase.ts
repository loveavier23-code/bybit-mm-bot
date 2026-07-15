/**
 * Local persistence layer (replaces Supabase).
 *
 * Uses Prisma + SQLite for trades, equity history, and bot state.
 * Keeps the same export names as the previous Supabase implementation
 * so bot-service.ts doesn't need invasive edits.
 *
 * `getSupabase()` is kept as a no-op (returns null) for backward
 * compatibility with bot-service.ts call sites that haven't been
 * fully migrated. New code should use the explicit async functions
 * below.
 */

import { db } from "@/lib/db";

// ============================================================================
// Types (kept identical to the old Supabase version)
// ============================================================================

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

// ============================================================================
// Backward-compat stub. bot-service.ts calls getSupabase() in a few places
// to update pg_cron / halted state. We return null so those call sites
// short-circuit gracefully — those calls have been removed from the local
// build, but the stub keeps type checking happy.
// ============================================================================

export function getSupabase(): null {
  return null;
}

// ============================================================================
// Trade persistence
// ============================================================================

export async function persistTrade(trade: TradeRow): Promise<void> {
  try {
    await db.trade.create({
      data: {
        ts: trade.ts,
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.entry_price,
        exitPrice: trade.exit_price,
        qty: trade.qty,
        grossPnl: trade.gross_pnl,
        fees: trade.fees,
        netPnl: trade.net_pnl,
        closeReason: trade.close_reason,
        sessionId: trade.session_id ?? null,
      },
    });
  } catch (e: any) {
    console.error("[db] persistTrade error:", e.message);
  }
}

export async function persistEquityPoint(point: EquityRow): Promise<void> {
  try {
    await db.equityPoint.create({
      data: {
        ts: point.ts,
        equity: point.equity,
        available: point.available,
        pendingCount: point.pending_count,
        legsCount: point.legs_count,
        sessionId: point.session_id ?? null,
      },
    });
  } catch (e: any) {
    console.error("[db] persistEquityPoint error:", e.message);
  }
}

export async function loadTradeHistory(limit: number = 200): Promise<any[]> {
  try {
    const rows = await db.trade.findMany({
      orderBy: { ts: "desc" },
      take: limit,
    });
    // Map Prisma column names back to the old Supabase snake_case shape.
    return rows.map((r) => ({
      ts: r.ts,
      symbol: r.symbol,
      side: r.side,
      entry_price: r.entryPrice,
      exit_price: r.exitPrice,
      qty: r.qty,
      gross_pnl: r.grossPnl,
      fees: r.fees,
      net_pnl: r.netPnl,
      close_reason: r.closeReason,
      session_id: r.sessionId,
    }));
  } catch (e: any) {
    console.error("[db] loadTradeHistory error:", e.message);
    return [];
  }
}

export async function loadEquityHistory(limit: number = 300): Promise<any[]> {
  try {
    const rows = await db.equityPoint.findMany({
      orderBy: { ts: "desc" },
      take: limit,
    });
    // Reverse to oldest-first for charting.
    return rows.reverse().map((r) => ({
      ts: r.ts,
      equity: r.equity,
      available: r.available,
      pending_count: r.pendingCount,
      legs_count: r.legsCount,
      session_id: r.sessionId,
    }));
  } catch (e: any) {
    console.error("[db] loadEquityHistory error:", e.message);
    return [];
  }
}

export async function loadBotState(): Promise<any | null> {
  try {
    const row = await db.botState.findUnique({ where: { id: 1 } });
    if (!row) return null;
    return {
      id: row.id,
      config: JSON.parse(row.config || "{}"),
      session_stats: JSON.parse(row.sessionStats || "{}"),
      equity_peak: row.equityPeak,
      halted: row.halted,
      updated_at: row.updatedAt.toISOString(),
    };
  } catch (e: any) {
    console.error("[db] loadBotState error:", e.message);
    return null;
  }
}

export async function saveBotState(state: {
  config: any;
  session_stats: any;
  equity_peak: number;
  halted: boolean;
}): Promise<void> {
  try {
    await db.botState.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        config: JSON.stringify(state.config),
        sessionStats: JSON.stringify(state.session_stats),
        equityPeak: state.equity_peak,
        halted: state.halted,
      },
      update: {
        config: JSON.stringify(state.config),
        sessionStats: JSON.stringify(state.session_stats),
        equityPeak: state.equity_peak,
        halted: state.halted,
      },
    });
  } catch (e: any) {
    console.error("[db] saveBotState error:", e.message);
  }
}

// Convenience: prune old equity points so SQLite doesn't grow forever.
// Called periodically from the worker tick.
export async function pruneOldEquityPoints(keep: number = 5000): Promise<void> {
  try {
    const count = await db.equityPoint.count();
    if (count <= keep) return;
    const oldest = await db.equityPoint.findFirst({
      orderBy: { ts: "desc" },
      skip: keep - 1,
    });
    if (!oldest) return;
    await db.equityPoint.deleteMany({ where: { ts: { lt: oldest.ts } } });
  } catch (e: any) {
    console.error("[db] pruneOldEquityPoints error:", e.message);
  }
}
