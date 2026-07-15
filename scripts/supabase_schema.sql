-- ============================================================================
-- Bybit MM Bot — Supabase schema
-- ============================================================================

-- Trades table: completed MM cycles with accurate PnL
CREATE TABLE IF NOT EXISTS trades (
    id BIGSERIAL PRIMARY KEY,
    ts BIGINT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price NUMERIC(20, 10) NOT NULL,
    exit_price NUMERIC(20, 10) NOT NULL,
    qty NUMERIC(20, 10) NOT NULL,
    gross_pnl NUMERIC(15, 6) NOT NULL,
    fees NUMERIC(15, 6) NOT NULL,
    net_pnl NUMERIC(15, 6) NOT NULL,
    close_reason TEXT NOT NULL,
    session_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Equity history: sampled equity curve points
CREATE TABLE IF NOT EXISTS equity_history (
    id BIGSERIAL PRIMARY KEY,
    ts BIGINT NOT NULL,
    equity NUMERIC(15, 6) NOT NULL,
    available NUMERIC(15, 6) NOT NULL,
    pending_count INT NOT NULL,
    legs_count INT NOT NULL,
    session_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bot state: persisted config and session stats
CREATE TABLE IF NOT EXISTS bot_state (
    id INT PRIMARY KEY DEFAULT 1,
    config JSONB NOT NULL,
    session_stats JSONB NOT NULL,
    equity_peak NUMERIC(15, 6) DEFAULT 0,
    halted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);

-- Open legs: currently unhedged positions (for crash recovery)
CREATE TABLE IF NOT EXISTS open_legs (
    id BIGSERIAL PRIMARY KEY,
    symbol TEXT NOT NULL UNIQUE,
    side TEXT NOT NULL,
    qty NUMERIC(20, 10) NOT NULL,
    entry_price NUMERIC(20, 10) NOT NULL,
    hedge_price NUMERIC(20, 10),
    open_ts BIGINT NOT NULL,
    hedge_order_id TEXT,
    session_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_equity_history_ts ON equity_history(ts DESC);

-- Enable RLS
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE equity_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_legs ENABLE ROW LEVEL SECURITY;

-- Permissive policies for demo
DROP POLICY IF EXISTS "Allow all for demo" ON trades;
CREATE POLICY "Allow all for demo" ON trades FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for demo" ON equity_history;
CREATE POLICY "Allow all for demo" ON equity_history FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for demo" ON bot_state;
CREATE POLICY "Allow all for demo" ON bot_state FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for demo" ON open_legs;
CREATE POLICY "Allow all for demo" ON open_legs FOR ALL USING (true) WITH CHECK (true);

-- Initialize bot_state
INSERT INTO bot_state (id, config, session_stats, equity_peak, halted)
VALUES (1, '{}'::jsonb, '{}'::jsonb, 0, false)
ON CONFLICT (id) DO NOTHING;
