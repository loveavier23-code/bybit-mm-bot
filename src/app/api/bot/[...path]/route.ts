import { NextRequest, NextResponse } from "next/server";
import * as bot from "@/lib/bot-service";

/**
 * Bot API routes — all in-process, no separate bridge service needed.
 *
 * Endpoints (under /api/bot/<path>):
 *   GET  /health
 *   GET  /state
 *   POST /start
 *   POST /stop
 *   POST /cleanup
 *   GET  /config
 *   POST /config        (body: partial config)
 *   GET  /logs?n=200
 *   GET  /trades
 *   GET  /equity-history
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const route = path.join("/");
  const url = new URL(req.url);

  try {
    switch (route) {
      case "health": {
        // Use the bot-service's bybitGet which routes through Supabase proxy
        try {
          const t0 = Date.now();
          const r: any = await bot.healthCheck();
          const latency = Date.now() - t0;
          return NextResponse.json({
            status: r.reachable ? "ok" : "degraded",
            bot_running: false,
            last_error: r.error || null,
            bybit_reachable: r.reachable,
            bybit_latency_ms: r.reachable ? latency : null,
            proxy: r.proxy || false,
          }, { status: r.reachable ? 200 : 503 });
        } catch (e: any) {
          return NextResponse.json({
            status: "degraded",
            bot_running: false,
            last_error: e.message,
            bybit_reachable: false,
            bybit_latency_ms: null,
          }, { status: 503 });
        }
      }
      case "state": {
        const s = await bot.getSnapshot();
        return NextResponse.json(s);
      }
      case "config": {
        return NextResponse.json(bot.getConfig());
      }
      case "logs": {
        const n = parseInt(url.searchParams.get("n") || "200");
        return NextResponse.json({ logs: bot.getLogs(n), count: bot.getLogs(n).length });
      }
      case "trades": {
        const trades = await bot.getTradesAsync();
        return NextResponse.json({ trades });
      }
      case "equity-history": {
        const points = await bot.getEquityHistoryAsync();
        return NextResponse.json({ points });
      }
      default:
        return NextResponse.json({ error: `not found: GET ${route}` }, { status: 404 });
    }
  } catch (e: any) {
    console.error(`[bot GET /${route}] error:`, e);
    return NextResponse.json({ error: e.message, type: e.name }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const route = path.join("/");

  try {
    let body: any = null;
    try { body = await req.json(); } catch { /* no body */ }

    switch (route) {
      case "start": {
        const r = await bot.startBot();
        return NextResponse.json(r);
      }
      case "stop": {
        const r = await bot.stopBot();
        return NextResponse.json(r);
      }
      case "tick": {
        // Cron-triggered single cycle. Runs one tick of the bot.
        // If bot isn't running, start it first (stateless-friendly).
        // Auth: requires CRON_SECRET header to prevent abuse.
        const cronSecret = req.headers.get("x-cron-secret");
        const expectedSecret = process.env.CRON_SECRET;
        if (expectedSecret && cronSecret !== expectedSecret) {
          return NextResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        const r = await bot.cronTick();
        return NextResponse.json(r);
      }
      case "cleanup": {
        const r = await bot.cleanupBot();
        return NextResponse.json(r);
      }
      case "close-position": {
        // Body: { symbol: "LABUSDT" }
        const symbol = body?.symbol;
        if (!symbol) {
          return NextResponse.json({ error: "symbol required" }, { status: 400 });
        }
        const r = await bot.closePositionApi(symbol);
        return NextResponse.json(r);
      }
      case "config": {
        const r = bot.updateConfig(body || {});
        return NextResponse.json(r);
      }
      default:
        return NextResponse.json({ error: `not found: POST ${route}` }, { status: 404 });
    }
  } catch (e: any) {
    console.error(`[bot POST /${route}] error:`, e);
    return NextResponse.json({ error: e.message, type: e.name }, { status: 500 });
  }
}
