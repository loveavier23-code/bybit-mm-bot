'use client'

import { useEffect, useState, useCallback, useRef } from "react"
import {
  Activity, Play, Square, Trash2, RefreshCw, TrendingUp, TrendingDown,
  Wallet, Layers, AlertTriangle, Settings, Terminal, Zap,
} from "lucide-react"
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs"
import { toast } from "sonner"
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts"
import {
  api, BotState, LogEntry, EquityPoint, Trade, BotConfig,
} from "@/lib/bot-api"

export default function Home() {
  const [state, setState] = useState<BotState | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [trades, setTrades] = useState<Trade[]>([])
  const [equityHistory, setEquityHistory] = useState<EquityPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [configDraft, setConfigDraft] = useState<BotConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ---- Polling ----
  const refresh = useCallback(async () => {
    try {
      const [s, l, t, e] = await Promise.all([
        api<BotState>("/state"),
        api<{ logs: LogEntry[] }>("/logs?n=200"),
        api<{ trades: Trade[] }>("/trades"),
        api<{ points: EquityPoint[] }>("/equity-history"),
      ])
      setState(s)
      setLogs(l.logs)
      setTrades(t.trades)
      setEquityHistory(e.points)
      setConfigDraft(s.config)
      setError(null)
    } catch (err: any) {
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    pollRef.current = setInterval(refresh, 3000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refresh])

  // ---- Actions ----
  const callAction = async (name: string, fn: () => Promise<any>) => {
    setBusy(name)
    try {
      const r = await fn()
      toast.success(`${name} OK`, { description: JSON.stringify(r) })
      await refresh()
    } catch (e: any) {
      toast.error(`${name} failed`, { description: e.message })
    } finally {
      setBusy(null)
    }
  }

  const startBot = () => callAction("Start", () => api("/start", { method: "POST" }))
  const stopBot = () => callAction("Stop", () => api("/stop", { method: "POST" }))
  const cleanup = () => callAction("Cleanup", () => api("/cleanup", { method: "POST" }))
  const saveConfig = () => {
    if (!configDraft) return
    callAction("Save Config", () =>
      api("/config", {
        method: "POST",
        body: JSON.stringify(configDraft),
      })
    )
  }

  // ---- Render ----
  const isRunning = state?.bot_running ?? false
  const equity = state?.equity ?? 0
  const equityPeak = state?.equity_peak ?? 0
  const pnl = equity - equityPeak
  const pnlPct = equityPeak > 0 ? (pnl / equityPeak) * 100 : 0
  const unrealisedPnl = state?.positions.reduce((s, p) => s + p.unrealised_pnl, 0) ?? 0

  // Chart data with formatted time
  const chartData = equityHistory.map(p => ({
    ...p,
    time: new Date(p.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }))

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/30 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary text-primary-foreground">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">Bybit MM Bot</h1>
              <p className="text-xs text-muted-foreground leading-tight">
                Spread-capture strategy · DEMO endpoint
              </p>
            </div>
            <Badge
              variant={isRunning ? "default" : "secondary"}
              className={`ml-2 ${isRunning ? "bg-emerald-600 hover:bg-emerald-600 text-white" : ""}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${isRunning ? "bg-white animate-pulse" : "bg-muted-foreground"}`} />
              {isRunning ? "RUNNING" : "STOPPED"}
            </Badge>
            {state?.last_error && (
              <Badge variant="destructive" className="ml-1">
                <AlertTriangle className="w-3 h-3 mr-1" /> Error
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={isRunning ? "destructive" : "default"}
              onClick={isRunning ? stopBot : startBot}
              disabled={busy !== null}
            >
              {busy === "Start" || busy === "Stop" ? (
                <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" />
              ) : isRunning ? (
                <Square className="w-4 h-4 mr-1.5" />
              ) : (
                <Play className="w-4 h-4 mr-1.5" />
              )}
              {isRunning ? "Stop" : "Start"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={cleanup}
              disabled={busy !== null}
            >
              {busy === "Cleanup" ? (
                <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-1.5" />
              )}
              Cleanup
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={refresh}
              disabled={busy !== null}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-6 space-y-6">
        {/* Connection banner */}
        {error && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="py-3 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
              <div className="text-sm">
                <span className="font-semibold text-destructive">Bridge unreachable:</span>{" "}
                <span className="text-muted-foreground">{error}</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Equity"
            value={`$${equity.toFixed(4)}`}
            icon={<Wallet className="w-4 h-4" />}
            sub={`Peak $${equityPeak.toFixed(4)}`}
          />
          <StatCard
            label="PnL vs Peak"
            value={`${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`}
            sub={`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`}
            icon={pnl >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            tone={pnl >= 0 ? "up" : "down"}
          />
          <StatCard
            label="Unrealised PnL"
            value={`${unrealisedPnl >= 0 ? "+" : ""}$${unrealisedPnl.toFixed(4)}`}
            sub={`${state?.positions.length ?? 0} open position${(state?.positions.length ?? 0) === 1 ? "" : "s"}`}
            icon={<Activity className="w-4 h-4" />}
            tone={unrealisedPnl >= 0 ? "up" : "down"}
          />
          <StatCard
            label="Active Cycles"
            value={`${state?.pending_pairs.length ?? 0} pending`}
            sub={`${state?.open_legs.length ?? 0} hedging`}
            icon={<Layers className="w-4 h-4" />}
          />
        </div>

        {/* Equity chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4" /> Equity Curve
            </CardTitle>
            <CardDescription>
              Live equity sampled every poll cycle (~3s). Up to ~15 minutes of history.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">
                No equity samples yet. Start the bot to begin charting.
              </div>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                    <XAxis
                      dataKey="time"
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={40}
                    />
                    <YAxis
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      domain={["auto", "auto"]}
                      width={60}
                      tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                      formatter={(v: any) => [`$${Number(v).toFixed(4)}`, "Equity"]}
                    />
                    <ReferenceLine y={equityPeak} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
                    <Line
                      type="monotone"
                      dataKey="equity"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Main tabs */}
        <Tabs defaultValue="positions" className="w-full">
          <TabsList className="grid w-full grid-cols-2 md:grid-cols-4 mb-3">
            <TabsTrigger value="positions">Positions & Orders</TabsTrigger>
            <TabsTrigger value="spreads">Live Spreads</TabsTrigger>
            <TabsTrigger value="trades">Trade History</TabsTrigger>
            <TabsTrigger value="config">Config</TabsTrigger>
          </TabsList>

          {/* Positions & Orders */}
          <TabsContent value="positions" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Open Positions</CardTitle>
                <CardDescription>Currently held perp positions from filled MM legs</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-64">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Symbol</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead className="text-right">Size</TableHead>
                        <TableHead className="text-right">Entry</TableHead>
                        <TableHead className="text-right">uPnL</TableHead>
                        <TableHead className="text-right">Margin</TableHead>
                        <TableHead>Leverage</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(state?.positions.length ?? 0) === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-6 text-sm">
                            No open positions
                          </TableCell>
                        </TableRow>
                      ) : (
                        state?.positions.map((p, i) => (
                          <TableRow key={`${p.symbol}-${i}`}>
                            <TableCell className="font-medium">{p.symbol}</TableCell>
                            <TableCell>
                              <Badge
                                variant={p.side === "Buy" ? "default" : "secondary"}
                                className={p.side === "Sell" ? "bg-rose-600 hover:bg-rose-600 text-white" : "bg-emerald-600 hover:bg-emerald-600 text-white"}
                              >
                                {p.side}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono">{p.size}</TableCell>
                            <TableCell className="text-right font-mono">{p.entry_price}</TableCell>
                            <TableCell className={`text-right font-mono ${p.unrealised_pnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                              {p.unrealised_pnl >= 0 ? "+" : ""}{p.unrealised_pnl.toFixed(4)}
                            </TableCell>
                            <TableCell className="text-right font-mono">{p.margin.toFixed(4)}</TableCell>
                            <TableCell className="text-muted-foreground">{p.leverage}x</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>

            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Pending MM Pairs</CardTitle>
                  <CardDescription>Both-leg orders waiting to fill</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <ScrollArea className="h-56">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Symbol</TableHead>
                          <TableHead className="text-right">Buy</TableHead>
                          <TableHead className="text-right">Sell</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Age</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(state?.pending_pairs.length ?? 0) === 0 ? (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center text-muted-foreground py-6 text-sm">
                              No pending pairs
                            </TableCell>
                          </TableRow>
                        ) : (
                          state?.pending_pairs.map((p, i) => (
                            <TableRow key={`${p.symbol}-${i}`}>
                              <TableCell className="font-medium">{p.symbol}</TableCell>
                              <TableCell className="text-right font-mono text-emerald-600">{p.buy_price}</TableCell>
                              <TableCell className="text-right font-mono text-rose-600">{p.sell_price}</TableCell>
                              <TableCell className="text-right font-mono">{p.qty}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{p.age_sec}s</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Open Hedge Legs</CardTitle>
                  <CardDescription>Filled legs awaiting hedge close</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <ScrollArea className="h-56">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Symbol</TableHead>
                          <TableHead>Side</TableHead>
                          <TableHead className="text-right">Entry</TableHead>
                          <TableHead className="text-right">Hedge</TableHead>
                          <TableHead className="text-right">Age</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(state?.open_legs.length ?? 0) === 0 ? (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center text-muted-foreground py-6 text-sm">
                              No open hedge legs
                            </TableCell>
                          </TableRow>
                        ) : (
                          state?.open_legs.map((l, i) => (
                            <TableRow key={`${l.symbol}-${i}`}>
                              <TableCell className="font-medium">{l.symbol}</TableCell>
                              <TableCell>
                                <Badge variant="outline">{l.side}</Badge>
                              </TableCell>
                              <TableCell className="text-right font-mono">{l.entry_price}</TableCell>
                              <TableCell className="text-right font-mono">{l.hedge_price}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{l.age_sec}s</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Raw Open Orders on Bybit</CardTitle>
                <CardDescription>All live orders (post-only + reduce-only)</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-48">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Symbol</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead>Reduce</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(state?.open_orders.length ?? 0) === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-6 text-sm">
                            No open orders
                          </TableCell>
                        </TableRow>
                      ) : (
                        state?.open_orders.map((o, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-medium">{o.symbol}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className={o.side === "Buy" ? "text-emerald-600 border-emerald-600" : "text-rose-600 border-rose-600"}>
                                {o.side}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground">{o.type}</TableCell>
                            <TableCell className="text-right font-mono">{o.qty}</TableCell>
                            <TableCell className="text-right font-mono">{o.price}</TableCell>
                            <TableCell>
                              {o.reduce_only ? <Badge variant="secondary" className="text-xs">reduce</Badge> : <span className="text-muted-foreground text-xs">—</span>}
                            </TableCell>
                            <TableCell><Badge variant="outline" className="text-xs">{o.status}</Badge></TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Live spreads */}
          <TabsContent value="spreads">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Top Spread Opportunities</CardTitle>
                <CardDescription>
                  Live bid/ask spread scan across the top-{state?.config.symbol_universe_size ?? 25} tradable altcoin perps.
                  Bot places orders on any symbol with spread ≥ {state?.config.min_spread_bps ?? 8} bps.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="text-right">Bid</TableHead>
                      <TableHead className="text-right">Ask</TableHead>
                      <TableHead className="text-right">Mid</TableHead>
                      <TableHead className="text-right">Spread (bps)</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(state?.top_spreads.length ?? 0) === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground py-6 text-sm">
                          No spread data yet — refresh in a moment.
                        </TableCell>
                      </TableRow>
                    ) : (
                      state?.top_spreads.map((s, i) => {
                        const minBps = state?.config.min_spread_bps ?? 8
                        const qualifies = s.spread_bps >= minBps
                        return (
                          <TableRow key={s.symbol}>
                            <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                            <TableCell className="font-medium">{s.symbol}</TableCell>
                            <TableCell className="text-right font-mono text-emerald-600">{s.bid}</TableCell>
                            <TableCell className="text-right font-mono text-rose-600">{s.ask}</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">{s.mid}</TableCell>
                            <TableCell className={`text-right font-mono font-semibold ${qualifies ? "text-emerald-600" : "text-muted-foreground"}`}>
                              {s.spread_bps.toFixed(2)}
                            </TableCell>
                            <TableCell>
                              {qualifies ? (
                                <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white text-xs">tradable</Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs">below threshold</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Trade history */}
          <TabsContent value="trades" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Closed Trades (this session)</CardTitle>
                <CardDescription>Completed MM cycles where both legs filled</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-72">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Symbol</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead className="text-right">Entry</TableHead>
                        <TableHead className="text-right">Exit</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Spread</TableHead>
                        <TableHead className="text-right">PnL</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {trades.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center text-muted-foreground py-6 text-sm">
                            No trades yet this session. Start the bot to begin trading.
                          </TableCell>
                        </TableRow>
                      ) : (
                        [...trades].reverse().map((t, i) => {
                          const spread = t.side === "Buy"
                            ? (t.exit - t.entry) * t.qty
                            : (t.entry - t.exit) * t.qty
                          return (
                            <TableRow key={i}>
                              <TableCell className="text-muted-foreground text-xs">
                                {new Date(t.ts * 1000).toLocaleTimeString()}
                              </TableCell>
                              <TableCell className="font-medium">{t.symbol}</TableCell>
                              <TableCell>
                                <Badge variant="outline">{t.side}</Badge>
                              </TableCell>
                              <TableCell className="text-right font-mono">{t.entry}</TableCell>
                              <TableCell className="text-right font-mono">{t.exit}</TableCell>
                              <TableCell className="text-right font-mono">{t.qty}</TableCell>
                              <TableCell className="text-right font-mono text-emerald-600">
                                +${spread.toFixed(4)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground text-xs">
                                {t.note}
                              </TableCell>
                            </TableRow>
                          )
                        })
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Terminal className="w-4 h-4" /> Live Log
                </CardTitle>
                <CardDescription>
                  Last {logs.length} log entries from the bot. Full log at{" "}
                  <code className="text-xs">/home/z/my-project/download/bot.log</code>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-72 rounded-md border bg-zinc-950">
                  <div className="p-3 font-mono text-xs space-y-0.5">
                    {logs.length === 0 ? (
                      <div className="text-zinc-500 py-4 text-center">No logs yet</div>
                    ) : (
                      [...logs].reverse().map((l, i) => (
                        <div key={i} className="flex gap-2 hover:bg-zinc-900 px-1 py-0.5 rounded">
                          <span className="text-zinc-500 shrink-0">
                            {new Date(l.ts * 1000).toLocaleTimeString([], { hour12: false })}
                          </span>
                          <span className={`shrink-0 font-bold ${
                            l.level === "ERROR" ? "text-rose-400" :
                            l.level === "WARNING" ? "text-amber-400" :
                            l.level === "INFO" ? "text-sky-400" :
                            "text-zinc-400"
                          }`}>
                            {l.level.padEnd(7)}
                          </span>
                          <span className="text-zinc-200 break-all">{l.msg}</span>
                        </div>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Config */}
          <TabsContent value="config">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Settings className="w-4 h-4" /> Strategy Configuration
                </CardTitle>
                <CardDescription>
                  Tune bot parameters live. Changes apply on the next cycle (no restart needed).
                  Note: updates only affect this FastAPI process — restart the bridge to make them permanent.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {configDraft && (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      <ConfigNumber
                        label="Margin per trade (%)"
                        value={configDraft.per_trade_margin_pct * 100}
                        step={0.1}
                        suffix="%"
                        onChange={(v) => setConfigDraft({ ...configDraft, per_trade_margin_pct: v / 100 })}
                        help="2% means 2% of equity as margin"
                      />
                      <ConfigNumber
                        label="Leverage"
                        value={configDraft.leverage}
                        step={1}
                        suffix="x"
                        onChange={(v) => setConfigDraft({ ...configDraft, leverage: Math.round(v) })}
                      />
                      <ConfigNumber
                        label="Max concurrent symbols"
                        value={configDraft.max_concurrent_symbols}
                        step={1}
                        onChange={(v) => setConfigDraft({ ...configDraft, max_concurrent_symbols: Math.round(v) })}
                      />
                      <ConfigNumber
                        label="Min spread (bps)"
                        value={configDraft.min_spread_bps}
                        step={0.5}
                        suffix=" bps"
                        onChange={(v) => setConfigDraft({ ...configDraft, min_spread_bps: v })}
                      />
                      <ConfigNumber
                        label="Target capture (bps)"
                        value={configDraft.target_capture_bps}
                        step={0.5}
                        suffix=" bps"
                        onChange={(v) => setConfigDraft({ ...configDraft, target_capture_bps: v })}
                      />
                      <ConfigNumber
                        label="Order timeout (s)"
                        value={configDraft.order_timeout_sec}
                        step={5}
                        suffix="s"
                        onChange={(v) => setConfigDraft({ ...configDraft, order_timeout_sec: Math.round(v) })}
                      />
                      <ConfigNumber
                        label="Poll interval (s)"
                        value={configDraft.poll_interval_sec}
                        step={1}
                        suffix="s"
                        onChange={(v) => setConfigDraft({ ...configDraft, poll_interval_sec: Math.round(v) })}
                      />
                      <ConfigNumber
                        label="Scan interval (s)"
                        value={configDraft.scan_interval_sec}
                        step={5}
                        suffix="s"
                        onChange={(v) => setConfigDraft({ ...configDraft, scan_interval_sec: Math.round(v) })}
                      />
                      <ConfigNumber
                        label="Max drawdown (%)"
                        value={configDraft.max_drawdown_pct * 100}
                        step={1}
                        suffix="%"
                        onChange={(v) => setConfigDraft({ ...configDraft, max_drawdown_pct: v / 100 })}
                      />
                      <ConfigNumber
                        label="Universe size"
                        value={configDraft.symbol_universe_size}
                        step={5}
                        onChange={(v) => setConfigDraft({ ...configDraft, symbol_universe_size: Math.round(v) })}
                      />
                    </div>

                    <div className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <Label className="font-medium">Auto min-notional</Label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Bump trade size to Bybit's 5 USDT min notional when 2% × equity × lev is too small.
                          Recommended for small demo balances.
                        </p>
                      </div>
                      <Switch
                        checked={configDraft.auto_min_notional}
                        onCheckedChange={(c) => setConfigDraft({ ...configDraft, auto_min_notional: c })}
                      />
                    </div>

                    <Separator />

                    <div className="flex items-center gap-3">
                      <Button onClick={saveConfig} disabled={busy !== null}>
                        {busy === "Save Config" ? (
                          <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" />
                        ) : (
                          <Settings className="w-4 h-4 mr-1.5" />
                        )}
                        Apply Config
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => state && setConfigDraft(state.config)}
                      >
                        Reset
                      </Button>
                      <span className="text-xs text-muted-foreground ml-auto">
                        Bot will pick up new values on the next poll cycle.
                      </span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Excluded Symbols</CardTitle>
                <CardDescription>
                  BTC/ETH hard-excluded per strategy. Other symbols auto-excluded at runtime
                  (e.g., tokenized stocks requiring agreements).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {state?.excluded_symbols.map((s) => (
                    <Badge key={s} variant="secondary" className="font-mono text-xs">{s}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      <footer className="border-t mt-auto bg-card/30">
        <div className="container mx-auto px-4 py-3 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
          <span>
            Bybit DEMO · spread-capture MM bot ·{" "}
            <a
              href="https://api-demo.bybit.com"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-foreground"
            >
              api-demo.bybit.com
            </a>
          </span>
          <span>
            BTC/ETH excluded · 2% margin · 10x leverage · 3s poll
          </span>
        </div>
      </footer>
    </div>
  )
}

// ============================================================================
// Sub-components
// ============================================================================

function StatCard({
  label, value, sub, icon, tone,
}: {
  label: string
  value: string
  sub?: string
  icon: React.ReactNode
  tone?: "up" | "down"
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className={tone === "up" ? "text-emerald-600" : tone === "down" ? "text-rose-600" : "text-muted-foreground"}>
            {icon}
          </span>
        </div>
        <div className={`text-lg font-bold font-mono ${tone === "up" ? "text-emerald-600" : tone === "down" ? "text-rose-600" : ""}`}>
          {value}
        </div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  )
}

function ConfigNumber({
  label, value, step, suffix, onChange, help,
}: {
  label: string
  value: number
  step?: number
  suffix?: string
  onChange: (v: number) => void
  help?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className={suffix ? "pr-12" : ""}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}
