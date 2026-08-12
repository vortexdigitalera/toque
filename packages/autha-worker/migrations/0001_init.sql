-- Autha Worker D1 Schema
-- Stores auth/captcha tokens and entity context uploaded by the Nusuk
-- browser extension. Queried by the toque container, MCP server, and dashboard.

CREATE TABLE IF NOT EXISTS records (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,           -- JSON blob (sanitized record)
  timestamp       INTEGER NOT NULL,        -- ms since epoch
  system_user_id  TEXT NOT NULL DEFAULT 'default',
  profile_tag     TEXT NOT NULL DEFAULT 'default',
  entity_id       TEXT,
  action          TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_entity    ON records(entity_id);
CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records(timestamp);
CREATE INDEX IF NOT EXISTS idx_records_action    ON records(action);
CREATE INDEX IF NOT EXISTS idx_records_user      ON records(system_user_id);
CREATE INDEX IF NOT EXISTS idx_records_key       ON records(key);
