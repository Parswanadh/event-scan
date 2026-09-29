-- Event attendance scanner schema (Cloudflare D1 / SQLite)
-- Applied with:
--   wrangler d1 execute event-scan-db --remote --file=./schema.sql
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Optional name lookup. The barcode carries only a registration number, so a
-- friendly name has to come from somewhere; this is that somewhere, and it is
-- entirely optional (the sheet falls back to showing the reg number alone).
CREATE TABLE IF NOT EXISTS roster (
  reg_no      TEXT PRIMARY KEY,
  name        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS scans (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_no            TEXT NOT NULL,
  raw_code          TEXT,
  event_id          INTEGER REFERENCES events(id),
  event_name        TEXT,
  -- 'in' opens a presence session, 'out' closes the open one.
  direction         TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  scan_type         TEXT NOT NULL DEFAULT 'check-in',
  -- Periods are a multi-select of 1..8; `periods` keeps exactly what was ticked
  -- (so P1+P5 is representable), while start/end are the min/max for reporting.
  periods           TEXT,
  period_start      INTEGER,
  period_end        INTEGER,
  hours             REAL,          -- count of selected periods (claimed attendance)
  session_minutes   INTEGER,       -- set on an 'out' row: minutes since its 'in'
  scanned_at        TEXT NOT NULL,              -- ISO-8601 UTC, device clock
  scanned_at_local  TEXT,                       -- same instant in venue wall-clock
  device            TEXT,
  ua                TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_scans_reg_no     ON scans(reg_no);
CREATE INDEX IF NOT EXISTS idx_scans_scanned_at ON scans(scanned_at);
CREATE INDEX IF NOT EXISTS idx_scans_event      ON scans(event_id, scanned_at);
-- The IN/OUT state lookup reads "latest row for this student in this event".
CREATE INDEX IF NOT EXISTS idx_scans_state      ON scans(reg_no, event_id, id DESC);

-- Failed organizer PIN attempts, for rate limiting. Rows older than the window
-- are pruned opportunistically on each write, so this table stays tiny.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ip           TEXT NOT NULL,
  attempted_at INTEGER NOT NULL                -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts ON auth_attempts(ip, attempted_at);

-- A default event so the very first scan has somewhere to land.
INSERT OR IGNORE INTO events (name) VALUES ('General');
