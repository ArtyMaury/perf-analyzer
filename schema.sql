-- D1 schema for shared, opt-in "clean" benchmark contributions.
--
-- Apply locally:   npm run db:migrate:local
-- Apply to prod:   npm run db:migrate
--
-- One row per contributed run. We store the raw measured CPU throughput
-- (Mops/s) plus context used for validation and de-duplication.

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cpu_name      TEXT    NOT NULL,           -- exact PassMark CPU name chosen by user
  cpu_mark      INTEGER NOT NULL,           -- PassMark multi-thread score (reference)
  mops          REAL    NOT NULL,           -- measured JS throughput (higher = better)
  cpu_ms        REAL,                       -- measured CPU time (ms, lower = better)
  intensity     TEXT,                       -- light | normal | heavy
  threads       INTEGER,                    -- navigator.hardwareConcurrency
  device_memory REAL,                       -- navigator.deviceMemory (approx GB)
  ua            TEXT,                        -- trimmed user-agent (context only)
  client_id     TEXT,                       -- random per-browser id (dedupe/rate context)
  created_at    INTEGER NOT NULL            -- unix ms
);

-- Fast lookups for baseline computation (group by CPU).
CREATE INDEX IF NOT EXISTS idx_runs_cpu ON runs (cpu_name);
CREATE INDEX IF NOT EXISTS idx_runs_cpu_created ON runs (cpu_name, created_at);

-- Lightweight rate-limiting / dedupe helper: recent submissions per client.
CREATE INDEX IF NOT EXISTS idx_runs_client_created ON runs (client_id, created_at);
