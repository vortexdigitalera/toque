/**
 * App Worker — D1-backed users, audit logs, and settings.
 *
 * Replaces Supabase for the toqueui dashboard. Authentication is handled
 * by Cloudflare Access (JWT verification) with an API-token fallback.
 *
 * Endpoints:
 *   GET  /health                          — health check (public)
 *
 *   ─── Auth ───
 *   GET  /api/me                           — current user profile (auto-provisions)
 *   POST /api/auth/login                   — create session (API-key mode)
 *   POST /api/auth/logout                  — destroy session
 *
 *   ─── Users ───
 *   GET  /api/users                        — list users (admin+)
 *   POST /api/users                        — create user (admin+)
 *   GET  /api/users/:id                    — get user
 *   PATCH /api/users/:id                   — update user (role, permissions, suspend)
 *   DELETE /api/users/:id                  — delete user (super_admin only)
 *
 *   ─── Audit Logs ───
 *   GET  /api/audit-logs                   — list audit logs (with filters)
 *   POST /api/audit-logs                   — create audit log entry
 *   GET  /api/audit-logs/stats             — aggregate metrics (last 5 min)
 *
 *   ─── Settings ───
 *   GET  /api/settings                     — list all settings
 *   GET  /api/settings/:key                — get one setting
 *   PUT  /api/settings                      — bulk upsert settings
 *   DELETE /api/settings/:key               — delete a setting
 *
 *   ─── Realtime ───
 *   GET  /ws/audit                          — WebSocket for real-time audit logs
 *
 * Auth:
 *   - Cloudflare Access JWT (Cf-Access-Jwt-Assertion header) — primary
 *   - APP_API_TOKEN (Bearer) — fallback for CLI/API clients
 */

import { AuditLogBroadcaster } from "./audit-broadcaster.js";

// ─── Helpers ────────────────────────────────────────────────────────

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function errorResponse(status, message) {
  return jsonResponse({ ok: false, error: message }, { status });
}

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

/** Parse and verify a Cloudflare Access JWT (simplified — checks structure + exp). */
function parseCfAccessJwt(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp && payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Extract user info from CF Access JWT payload. */
function userFromJwt(payload) {
  if (!payload) return null;
  return {
    id: payload.sub || payload.email || "",
    email: payload.email || "",
    name: payload.name || "",
  };
}

/** Authenticate the request, returning the user identity. */
async function authenticate(request, env) {
  // Try CF Access JWT first
  const jwtPayload = parseCfAccessJwt(request, env);
  if (jwtPayload) {
    return { source: "cf-access", ...userFromJwt(jwtPayload) };
  }
  // Fall back to API token
  if (env.APP_API_TOKEN) {
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token && token === env.APP_API_TOKEN) {
      return { source: "api-token", id: "api-client", email: "api@toque.local", name: "API Client" };
    }
  }
  return null;
}

/** Auto-provision a user from CF Access JWT. First admin email → super_admin. */
async function autoProvisionUser(env, userInfo) {
  if (!env.APP_DB || !userInfo?.email) return null;
  const existing = await env.APP_DB
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(userInfo.email)
    .first();
  if (existing) return existing;

  // Check if this is the first user or matches admin email
  const userCount = await env.APP_DB
    .prepare("SELECT COUNT(*) as count FROM users")
    .first();
  const isFirstUser = (userCount?.count || 0) === 0;
  const isAdminEmail = env.ADMIN_EMAIL && userInfo.email === env.ADMIN_EMAIL;
  const role = isFirstUser || isAdminEmail ? "super_admin" : "viewer";

  const id = userInfo.id || uuid();
  await env.APP_DB
    .prepare(
      `INSERT INTO users (id, email, full_name, avatar_url, role, permissions)
       VALUES (?, ?, ?, ?, ?, '{}')`,
    )
    .bind(id, userInfo.email, userInfo.name || "", "", role)
    .run();

  return { id, email: userInfo.email, full_name: userInfo.name || "", role, permissions: "{}" };
}

/** Get user from DB by email. */
async function getUserByEmail(env, email) {
  return env.APP_DB
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first();
}

/** Check if user has required role level. */
function hasRole(userRole, required) {
  const levels = { viewer: 0, operator: 1, admin: 2, super_admin: 3 };
  return (levels[userRole] || 0) >= (levels[required] || 0);
}

// ─── Worker ────────────────────────────────────────────────────────

export { AuditLogBroadcaster };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // ─── Health (public) ────────────────────────────────────────────
    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "app-worker",
        version: "1.0.0",
        storage: env.APP_DB ? "d1" : "none",
      });
    }

    // ─── WebSocket (real-time audit logs) ──────────────────────────
    if (url.pathname === "/ws/audit") {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return errorResponse(426, "Upgrade header required");
      }
      const user = await authenticate(request, env);
      if (!user) return errorResponse(401, "Unauthorized");
      const id = env.AUDIT_BROADCASTER.idFromName("default");
      const stub = env.AUDIT_BROADCASTER.get(id);
      return stub.fetch(request);
    }

    // ─── Auth check for all other routes ───────────────────────────
    const user = await authenticate(request, env);
    if (!user) {
      return errorResponse(401, "Unauthorized — provide CF Access JWT or API token");
    }

    // Ensure user exists in DB (auto-provision from CF Access)
    let dbUser = await getUserByEmail(env, user.email);
    if (!dbUser && user.source === "cf-access") {
      dbUser = await autoProvisionUser(env, user);
    }
    const userRole = dbUser?.role || "viewer";

    // ─── Routes ─────────────────────────────────────────────────────
    // Auth / me
    if (url.pathname === "/api/me" && method === "GET") {
      return jsonResponse({ ok: true, user: dbUser || user });
    }

    if (url.pathname === "/api/auth/login" && method === "POST") {
      return handleLogin(env, request, dbUser || user);
    }
    if (url.pathname === "/api/auth/logout" && method === "POST") {
      return handleLogout(env, request);
    }

    // Users
    if (url.pathname === "/api/users" && method === "GET") {
      if (!hasRole(userRole, "admin")) return errorResponse(403, "Admin access required");
      return handleListUsers(env);
    }
    if (url.pathname === "/api/users" && method === "POST") {
      if (!hasRole(userRole, "admin")) return errorResponse(403, "Admin access required");
      return handleCreateUser(env, request, user);
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch) {
      const id = decodeURIComponent(userMatch[1]);
      if (method === "GET") return handleGetUser(env, id);
      if (method === "PATCH") {
        if (!hasRole(userRole, "admin")) return errorResponse(403, "Admin access required");
        return handleUpdateUser(env, id, request, user);
      }
      if (method === "DELETE") {
        if (!hasRole(userRole, "super_admin")) return errorResponse(403, "Super admin access required");
        return handleDeleteUser(env, id);
      }
    }

    // Audit logs
    if (url.pathname === "/api/audit-logs" && method === "GET") {
      return handleListAuditLogs(env, url);
    }
    if (url.pathname === "/api/audit-logs" && method === "POST") {
      return handleCreateAuditLog(env, request, user, dbUser);
    }
    if (url.pathname === "/api/audit-logs/stats" && method === "GET") {
      return handleAuditStats(env);
    }

    // Settings
    if (url.pathname === "/api/settings" && method === "GET") {
      return handleListSettings(env);
    }
    if (url.pathname === "/api/settings" && method === "PUT") {
      if (!hasRole(userRole, "admin")) return errorResponse(403, "Admin access required");
      return handleUpsertSettings(env, request);
    }
    const settingMatch = url.pathname.match(/^\/api\/settings\/([^/]+)$/);
    if (settingMatch) {
      const key = decodeURIComponent(settingMatch[1]);
      if (method === "GET") return handleGetSetting(env, key);
      if (method === "DELETE") {
        if (!hasRole(userRole, "admin")) return errorResponse(403, "Admin access required");
        return handleDeleteSetting(env, key);
      }
    }

    return errorResponse(404, `Not found: ${url.pathname}`);
  },
};

// ─── Auth handlers ─────────────────────────────────────────────────

async function handleLogin(env, request, user) {
  const body = await request.json().catch(() => ({}));
  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  const ip = request.headers.get("CF-Connecting-IP") || null;
  const ua = request.headers.get("User-Agent") || null;

  await env.APP_DB
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, user.id || user.email, expiresAt, ip, ua)
    .run();

  return jsonResponse({ ok: true, sessionId, expiresAt, user: { id: user.id, email: user.email, role: user.role } });
}

async function handleLogout(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token) {
    await env.APP_DB.prepare("DELETE FROM sessions WHERE id = ?").bind(token).run();
  }
  return jsonResponse({ ok: true });
}

// ─── User handlers ─────────────────────────────────────────────────

async function handleListUsers(env) {
  const result = await env.APP_DB
    .prepare("SELECT id, email, full_name, avatar_url, role, permissions, suspended_at, created_at, updated_at FROM users ORDER BY created_at DESC")
    .all();
  return jsonResponse({ ok: true, users: result.results || [], count: (result.results || []).length });
}

async function handleCreateUser(env, request, currentUser) {
  const body = await request.json().catch(() => ({}));
  if (!body.email) return errorResponse(400, "Email is required");
  const id = body.id || uuid();
  const role = body.role || "viewer";
  const fullName = body.full_name || body.fullName || "";
  await env.APP_DB
    .prepare(
      `INSERT INTO users (id, email, full_name, role, permissions)
       VALUES (?, ?, ?, ?, '{}')`,
    )
    .bind(id, body.email, fullName, role)
    .run();
  // Audit log
  await logAudit(env, currentUser, "team_create_account", "team-management", { target_email: body.email, assigned_role: role });
  return jsonResponse({ ok: true, user: { id, email: body.email, full_name: fullName, role } }, { status: 201 });
}

async function handleGetUser(env, id) {
  const user = await env.APP_DB
    .prepare("SELECT id, email, full_name, avatar_url, role, permissions, suspended_at, created_at, updated_at FROM users WHERE id = ?")
    .bind(id)
    .first();
  if (!user) return errorResponse(404, "User not found");
  return jsonResponse({ ok: true, user });
}

async function handleUpdateUser(env, id, request, currentUser) {
  const body = await request.json().catch(() => ({}));
  const existing = await env.APP_DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!existing) return errorResponse(404, "User not found");

  const updates = [];
  const binds = [];
  if (body.role !== undefined) { updates.push("role = ?"); binds.push(body.role); }
  if (body.full_name !== undefined) { updates.push("full_name = ?"); binds.push(body.full_name); }
  if (body.permissions !== undefined) { updates.push("permissions = ?"); binds.push(JSON.stringify(body.permissions)); }
  if (body.suspended !== undefined) {
    if (body.suspended) {
      updates.push("suspended_at = ?"); binds.push(now());
      updates.push("suspended_by = ?"); binds.push(currentUser.email);
      if (body.reason) { updates.push("suspension_reason = ?"); binds.push(body.reason); }
    } else {
      updates.push("suspended_at = NULL"); updates.push("suspended_by = NULL"); updates.push("suspension_reason = NULL");
    }
  }
  updates.push("updated_at = ?"); binds.push(now());
  binds.push(id);

  if (updates.length > 1) {
    await env.APP_DB
      .prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
  }

  await logAudit(env, currentUser, "team_update_role", "team-management", { target_id: id, changes: body });
  return jsonResponse({ ok: true, id });
}

async function handleDeleteUser(env, id) {
  await env.APP_DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  return jsonResponse({ ok: true, id });
}

// ─── Audit log handlers ─────────────────────────────────────────────

async function handleListAuditLogs(env, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
  const offset = Number(url.searchParams.get("offset")) || 0;
  const action = url.searchParams.get("action");
  const panel = url.searchParams.get("panel");
  const userId = url.searchParams.get("userId");

  let sql = "SELECT id, user_id, user_email, action, panel, details, ip_address, created_at FROM audit_logs WHERE 1=1";
  const binds = [];
  if (action) { sql += " AND action = ?"; binds.push(action); }
  if (panel) { sql += " AND panel = ?"; binds.push(panel); }
  if (userId) { sql += " AND user_id = ?"; binds.push(userId); }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  binds.push(limit, offset);

  const result = await env.APP_DB.prepare(sql).bind(...binds).all();
  return jsonResponse({ ok: true, logs: result.results || [], count: (result.results || []).length });
}

async function handleCreateAuditLog(env, request, user, dbUser) {
  const body = await request.json().catch(() => ({}));
  const id = uuid();
  const ip = request.headers.get("CF-Connecting-IP") || null;

  await env.APP_DB
    .prepare(
      `INSERT INTO audit_logs (id, user_id, user_email, action, panel, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      user.id || dbUser?.id || null,
      user.email || dbUser?.email || null,
      body.action || "unknown",
      body.panel || null,
      JSON.stringify(body.details || {}),
      ip,
    )
    .run();

  // Broadcast to WebSocket subscribers via Durable Object
  const entry = {
    id,
    user_id: user.id || dbUser?.id || null,
    user_email: user.email || dbUser?.email || null,
    action: body.action || "unknown",
    panel: body.panel || null,
    details: body.details || {},
    ip_address: ip,
    created_at: now(),
  };
  try {
    const doId = env.AUDIT_BROADCASTER.idFromName("default");
    const stub = env.AUDIT_BROADCASTER.get(doId);
    await stub.fetch("https://internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch {
    // Best-effort broadcast — don't fail the request
  }

  return jsonResponse({ ok: true, id }, { status: 201 });
}

async function handleAuditStats(env) {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const total = await env.APP_DB
    .prepare("SELECT COUNT(*) as count FROM audit_logs WHERE created_at >= ?")
    .bind(fiveMinAgo)
    .first();
  const errors = await env.APP_DB
    .prepare(
      `SELECT COUNT(*) as count FROM audit_logs
       WHERE created_at >= ? AND (action LIKE '%error%' OR action LIKE '%fail%' OR action LIKE '%denied%')`,
    )
    .bind(fiveMinAgo)
    .first();
  const byAction = await env.APP_DB
    .prepare(
      `SELECT action, COUNT(*) as count FROM audit_logs
       WHERE created_at >= ? GROUP BY action ORDER BY count DESC LIMIT 20`,
    )
    .bind(fiveMinAgo)
    .all();

  return jsonResponse({
    ok: true,
    stats: {
      total: total?.count || 0,
      errors: errors?.count || 0,
      byAction: (byAction.results || []).map((r) => ({ ...r })),
    },
  });
}

/** Internal: log audit without HTTP response (used by other handlers). */
async function logAudit(env, user, action, panel, details) {
  const id = uuid();
  await env.APP_DB
    .prepare(
      `INSERT INTO audit_logs (id, user_id, user_email, action, panel, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, user.id || null, user.email || null, action, panel, JSON.stringify(details || {}))
    .run();
}

// ─── Settings handlers ──────────────────────────────────────────────

async function handleListSettings(env) {
  const result = await env.APP_DB
    .prepare("SELECT key, value, updated_at FROM settings ORDER BY key")
    .all();
  const settings = {};
  for (const row of result.results || []) {
    try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; }
  }
  return jsonResponse({ ok: true, settings });
}

async function handleGetSetting(env, key) {
  const row = await env.APP_DB
    .prepare("SELECT key, value, updated_at FROM settings WHERE key = ?")
    .bind(key)
    .first();
  if (!row) return errorResponse(404, `Setting not found: ${key}`);
  let value;
  try { value = JSON.parse(row.value); } catch { value = row.value; }
  return jsonResponse({ ok: true, key, value, updated_at: row.updated_at });
}

async function handleUpsertSettings(env, request) {
  const body = await request.json().catch(() => ({}));
  const settings = body.settings || body;
  if (typeof settings !== "object" || settings === null) {
    return errorResponse(400, "Expected settings object");
  }
  const ts = now();
  for (const [key, value] of Object.entries(settings)) {
    const stored = typeof value === "string" ? value : JSON.stringify(value);
    await env.APP_DB
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, stored, ts)
      .run();
  }
  return jsonResponse({ ok: true, count: Object.keys(settings).length });
}

async function handleDeleteSetting(env, key) {
  await env.APP_DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  return jsonResponse({ ok: true, key });
}
