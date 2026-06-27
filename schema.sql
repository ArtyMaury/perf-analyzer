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
  client_id     TEXT,                       -- random per-browser id (dedupe context)
  ip            TEXT,                        -- network client IP (rate-limit only)
  created_at    INTEGER NOT NULL            -- unix ms
);

-- Fast lookups for baseline computation (group by CPU).
CREATE INDEX IF NOT EXISTS idx_runs_cpu ON runs (cpu_name);
CREATE INDEX IF NOT EXISTS idx_runs_cpu_created ON runs (cpu_name, created_at);

-- Lightweight rate-limiting helper: recent submissions per IP.
CREATE INDEX IF NOT EXISTS idx_runs_ip_created ON runs (ip, created_at);

-- ---------------------------------------------------------------------------
-- Generic metric runs (disk / RAM).
--
-- The CPU table above is keyed by the exact CPU model the user picks. Disk and
-- RAM have no model exposed by the browser, so we group community runs by a
-- coarse "group_key" (RAM: deviceMemory GB; disk: OS family). `score` is the
-- measured throughput where HIGHER IS BETTER (disk: Mo/s, RAM: Go/s), mirroring
-- `mops` for the CPU. The baseline endpoint trims low outliers the same way.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metric_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  metric        TEXT    NOT NULL,           -- 'disk' | 'ram'
  group_key     TEXT    NOT NULL,           -- coarse grouping (RAM GB / OS family)
  score         REAL    NOT NULL,           -- measured throughput (higher = better)
  unit          TEXT,                        -- 'Mo/s' | 'Go/s' (display context)
  read_score    REAL,                        -- secondary read throughput (context)
  intensity     TEXT,                        -- light | normal | heavy
  threads       INTEGER,                     -- navigator.hardwareConcurrency
  device_memory REAL,                         -- navigator.deviceMemory (approx GB)
  os            TEXT,                          -- detected OS family (context)
  ua            TEXT,                          -- trimmed user-agent (context only)
  client_id     TEXT,                          -- random per-browser id
  ip            TEXT,                          -- network client IP (rate-limit only)
  created_at    INTEGER NOT NULL               -- unix ms
);

-- Fast lookups for baseline computation (group by metric + group_key).
CREATE INDEX IF NOT EXISTS idx_metric_runs_lookup
  ON metric_runs (metric, group_key, created_at);

-- Rate-limit helper for the generic table (recent submissions per IP).
CREATE INDEX IF NOT EXISTS idx_metric_runs_ip_created
  ON metric_runs (ip, created_at);
