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
  scan_type         TEXT NOT NULL DEFAULT 'check-in',
  period_start      INTEGER,
  period_end        INTEGER,
  hours             REAL,
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
