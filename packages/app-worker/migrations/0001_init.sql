-- App Worker D1 Schema
-- Replaces Supabase auth + user_profiles + audit_logs + settings.
-- Used by the toqueui dashboard via Cloudflare Access for authentication.

-- ─── Users ─────────────────────────────────────────────────────────
-- Stores user profiles. Auth is handled by Cloudflare Access (JWT),
-- so we don't store passwords here. Users are auto-provisioned on first
-- login from the CF Access JWT claims (email, name).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- CF Access sub (or email-derived UUID)
  email TEXT NOT NULL UNIQUE,
  full_name TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'viewer',  -- super_admin | admin | operator | viewer
  permissions TEXT DEFAULT '{}',    -- JSON object of panel permissions
  suspended_at TEXT DEFAULT NULL,
  suspended_by TEXT DEFAULT NULL,
  suspension_reason TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ─── Audit Logs ─────────────────────────────────────────────────────
-- Replaces the Supabase audit_logs table. Written by the app-worker
-- and read by the dashboard. Real-time updates are pushed via the
-- AuditLogBroadcaster Durable Object.

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,              -- UUID
  user_id TEXT,
  user_email TEXT,
  action TEXT NOT NULL,
  panel TEXT DEFAULT NULL,
  details TEXT DEFAULT '{}',        -- JSON object
  ip_address TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_panel ON audit_logs(panel);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

-- ─── Settings ──────────────────────────────────────────────────────
-- D1-backed configurable options (synced from `nusuk config sync`).
-- Key-value store with JSON values.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Sessions (optional, for non-CF-Access clients) ────────────────
-- When Cloudflare Access is the auth provider, sessions are JWT-based
-- and stateless. This table is for API-key sessions or SSH-based access.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- session token (random UUID)
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip_address TEXT DEFAULT NULL,
  user_agent TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ─── Default super_admin ───────────────────────────────────────────
-- Auto-provisioned on first login. The first user to authenticate
-- via Cloudflare Access with the configured admin email gets super_admin.
-- This is enforced in the app-worker's auto-provision logic, not here.
