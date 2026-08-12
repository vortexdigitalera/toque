import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the app-worker's user management, audit logs, and settings.
 * Uses a fake D1 + fake Durable Object to exercise the Worker's fetch handler.
 */

const workerModule = await import("../packages/app-worker/src/index.js");
const worker = workerModule.default;

// ─── Fake D1 ────────────────────────────────────────────────────────

function createFakeD1() {
  const tables = {
    users: new Map(),
    audit_logs: new Map(),
    settings: new Map(),
    sessions: new Map(),
  };
  const d1 = {
    tables,
    prepare(sql) {
      let b = [];
      const bind = (...args) => { b = args; return stmt; };
      const stmt = {
        bind,
        async run() {
          const s = sql.trim().toUpperCase();
          if (s.startsWith("INSERT INTO USERS")) {
            const [id, email, fullName, avatar, role, perms] = b;
            tables.users.set(id, { id, email, full_name: fullName, avatar_url: avatar, role, permissions: perms || "{}", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
            return { success: true };
          }
          if (s.startsWith("INSERT INTO AUDIT_LOGS")) {
            const [id, userId, userEmail, action, panel, details, ip] = b;
            tables.audit_logs.set(id, { id, user_id: userId, user_email: userEmail, action, panel, details, ip_address: ip, created_at: new Date().toISOString() });
            return { success: true };
          }
          if (s.startsWith("INSERT INTO SESSIONS")) {
            const [id, userId, expiresAt, ip, ua] = b;
            tables.sessions.set(id, { id, user_id: userId, expires_at: expiresAt, ip_address: ip, user_agent: ua });
            return { success: true };
          }
          if (s.startsWith("INSERT INTO SETTINGS") || s.startsWith("INSERT OR REPLACE")) {
            const [key, value, ts] = b;
            tables.settings.set(key, { key, value, updated_at: ts });
            return { success: true };
          }
          if (s.startsWith("DELETE FROM SESSIONS")) {
            tables.sessions.delete(b[0]);
            return { success: true };
          }
          if (s.startsWith("DELETE FROM USERS")) {
            tables.users.delete(b[0]);
            return { success: true };
          }
          if (s.startsWith("DELETE FROM SETTINGS")) {
            tables.settings.delete(b[0]);
            return { success: true };
          }
          if (s.startsWith("UPDATE USERS SET")) {
            // Simple update — find by id (last binding)
            const id = b[b.length - 1];
            const existing = tables.users.get(id);
            if (existing) {
              if (s.includes("ROLE = ?")) existing.role = b[0];
              existing.updated_at = new Date().toISOString();
              tables.users.set(id, existing);
            }
            return { success: true };
          }
          return { success: true };
        },
        async all() {
          const s = sql.trim().toUpperCase();
          if (s.startsWith("SELECT") && s.includes("FROM USERS")) {
            const users = [...tables.users.values()].sort((a, c) => c.created_at.localeCompare(a.created_at));
            return { results: users };
          }
          if (s.startsWith("SELECT") && s.includes("FROM AUDIT_LOGS")) {
            let logs = [...tables.audit_logs.values()];
            // Apply filters
            if (s.includes("WHERE 1=1")) {
              if (s.includes("AND ACTION = ?") && b.length > 0) logs = logs.filter((l) => l.action === b[0]);
              if (s.includes("AND PANEL = ?")) logs = logs.filter((l) => l.panel === b[1] || l.panel === b[0]);
            }
            logs.sort((a, c) => c.created_at.localeCompare(a.created_at));
            const limit = b[b.length - 2] || 50;
            const offset = b[b.length - 1] || 0;
            return { results: logs.slice(offset, offset + limit) };
          }
          if (s.startsWith("SELECT") && s.includes("FROM SETTINGS")) {
            const settings = [...tables.settings.values()].sort((a, c) => a.key.localeCompare(c.key));
            return { results: settings };
          }
          if (s.startsWith("SELECT") && s.includes("COUNT(*)") && s.includes("FROM AUDIT_LOGS")) {
            let logs = [...tables.audit_logs.values()];
            if (s.includes("CREATED_AT >=")) {
              const since = b[0];
              logs = logs.filter((l) => l.created_at >= since);
            }
            if (s.includes("ACTION LIKE")) {
              logs = logs.filter((l) => /error|fail|denied/i.test(l.action));
            }
            return { results: [{ count: logs.length }] };
          }
          if (s.startsWith("SELECT") && s.includes("GROUP BY ACTION")) {
            const counts = new Map();
            for (const l of tables.audit_logs.values()) {
              counts.set(l.action, (counts.get(l.action) || 0) + 1);
            }
            return { results: [...counts.entries()].map(([action, count]) => ({ action, count })) };
          }
          return { results: [] };
        },
        async first() {
          const s = sql.trim().toUpperCase();
          if (s.startsWith("SELECT") && s.includes("FROM USERS WHERE EMAIL")) {
            for (const u of tables.users.values()) {
              if (u.email === b[0]) return u;
            }
            return null;
          }
          if (s.startsWith("SELECT") && s.includes("FROM USERS WHERE ID")) {
            return tables.users.get(b[0]) || null;
          }
          if (s.startsWith("SELECT") && s.includes("FROM SETTINGS WHERE KEY")) {
            return tables.settings.get(b[0]) || null;
          }
          if (s.startsWith("SELECT COUNT(*)") && s.includes("FROM USERS")) {
            return { count: tables.users.size };
          }
          if (s.startsWith("SELECT") && s.includes("FROM AUDIT_LOGS") && s.includes("CREATED_AT >=")) {
            const since = b[0];
            const logs = [...tables.audit_logs.values()].filter((l) => l.created_at >= since);
            if (s.includes("ACTION LIKE")) {
              const errCount = logs.filter((l) => /error|fail|denied/i.test(l.action)).length;
              return { count: errCount };
            }
            return { count: logs.length };
          }
          const res = await stmt.all();
          return res.results[0] || null;
        },
      };
      return stmt;
    },
  };
  return d1;
}

// ─── Fake Durable Object ────────────────────────────────────────────

function createFakeDO() {
  const broadcasts = [];
  return {
    idFromName() { return "fake-do-id"; },
    get() {
      return {
        async fetch(url, init) {
          if (init?.method === "POST") {
            broadcasts.push(JSON.parse(init.body));
          }
          return new Response(JSON.stringify({ ok: true, delivered: 0 }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      };
    },
    broadcasts,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

const API_TOKEN = "test-app-token";
const ADMIN_EMAIL = "admin@toque.test";

function makeEnv() {
  return {
    APP_DB: createFakeD1(),
    AUDIT_BROADCASTER: createFakeDO(),
    APP_API_TOKEN: API_TOKEN,
    ADMIN_EMAIL,
  };
}

function authedRequest(path, { method = "GET", body, token = API_TOKEN } = {}) {
  const headers = { "Authorization": `Bearer ${token}` };
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  return new Request(`https://app-worker.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function fetchWorker(request, env) {
  return worker.fetch(request, env);
}

// ─── Tests ──────────────────────────────────────────────────────────

test("health endpoint is public", async () => {
  const env = makeEnv();
  const res = await fetchWorker(new Request("https://app-worker.test/health"), env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.service, "app-worker");
});

test("rejects unauthenticated requests", async () => {
  const env = makeEnv();
  const res = await fetchWorker(new Request("https://app-worker.test/api/me"), env);
  assert.equal(res.status, 401);
});

test("api token auth works", async () => {
  const env = makeEnv();
  const res = await fetchWorker(authedRequest("/api/me"), env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.user.email, "api@toque.local");
});

test("auto-provisions first user as super_admin via CF Access JWT", async () => {
  const env = makeEnv();
  // Create a fake CF Access JWT
  const header = btoa(JSON.stringify({ alg: "RS256" })).replace(/=/g, "");
  const payload = btoa(JSON.stringify({
    sub: "user-123",
    email: ADMIN_EMAIL,
    name: "Admin User",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).replace(/=/g, "");
  const jwt = `${header}.${payload}.signature`;
  const req = new Request("https://app-worker.test/api/me", {
    headers: { "Cf-Access-Jwt-Assertion": jwt },
  });
  const res = await fetchWorker(req, env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.user.email, ADMIN_EMAIL);
  assert.equal(json.user.role, "super_admin");
});

test("lists users (admin required)", async () => {
  const env = makeEnv();
  // First, provision a user via CF Access
  const header = btoa(JSON.stringify({ alg: "RS256" })).replace(/=/g, "");
  const payload = btoa(JSON.stringify({
    sub: "admin-1", email: ADMIN_EMAIL, name: "Admin", exp: Math.floor(Date.now() / 1000) + 3600,
  })).replace(/=/g, "");
  const jwt = `${header}.${payload}.sig`;
  await fetchWorker(new Request("https://app-worker.test/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), env);

  // List users with API token (api@toque.local has viewer role — should fail)
  const resViewer = await fetchWorker(authedRequest("/api/users"), env);
  assert.equal(resViewer.status, 403);

  // Manually set api user role to admin
  const apiUser = [...env.APP_DB.tables.users.values()].find((u) => u.email === "api@toque.local");
  // API token user doesn't exist in DB — let's create one
  await env.APP_DB.prepare("INSERT INTO USERS (?, ?, ?, ?, ?, ?)").bind("api-1", "api@toque.local", "API", "", "admin", "{}").run();

  const resAdmin = await fetchWorker(authedRequest("/api/users"), env);
  assert.equal(resAdmin.status, 200);
  const json = await resAdmin.json();
  assert.ok(json.users.length > 0);
});

test("creates a user (admin required)", async () => {
  const env = makeEnv();
  // Provision admin
  await env.APP_DB.prepare("INSERT INTO USERS (?, ?, ?, ?, ?, ?)").bind("admin-1", "api@toque.local", "Admin", "", "admin", "{}").run();
  const res = await fetchWorker(authedRequest("/api/users", {
    method: "POST",
    body: { email: "newuser@toque.test", full_name: "New User", role: "operator" },
  }), env);
  const json = await res.json();
  assert.equal(res.status, 201);
  assert.equal(json.user.email, "newuser@toque.test");
  assert.equal(json.user.role, "operator");
});

test("creates and lists audit logs", async () => {
  const env = makeEnv();
  await env.APP_DB.prepare("INSERT INTO USERS (?, ?, ?, ?, ?, ?)").bind("u1", "api@toque.local", "API", "", "admin", "{}").run();

  // Create audit log
  const createRes = await fetchWorker(authedRequest("/api/audit-logs", {
    method: "POST",
    body: { action: "login", panel: "auth", details: { method: "password" } },
  }), env);
  assert.equal(createRes.status, 201);
  const createJson = await createRes.json();
  assert.ok(createJson.id);

  // List audit logs
  const listRes = await fetchWorker(authedRequest("/api/audit-logs"), env);
  const listJson = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.ok(listJson.logs.length > 0);
  assert.equal(listJson.logs[0].action, "login");
});

test("audit log creation broadcasts to Durable Object", async () => {
  const env = makeEnv();
  await env.APP_DB.prepare("INSERT INTO USERS (?, ?, ?, ?, ?, ?)").bind("u1", "api@toque.local", "API", "", "admin", "{}").run();
  await fetchWorker(authedRequest("/api/audit-logs", {
    method: "POST",
    body: { action: "test_action", panel: "test" },
  }), env);
  assert.ok(env.AUDIT_BROADCASTER.broadcasts.length > 0, "should have broadcast to DO");
  assert.equal(env.AUDIT_BROADCASTER.broadcasts[0].action, "test_action");
});

test("audit stats returns counts", async () => {
  const env = makeEnv();
  await env.APP_DB.prepare("INSERT INTO USERS (?, ?, ?, ?, ?, ?)").bind("u1", "api@toque.local", "API", "", "admin", "{}").run();
  // Create some logs
  await fetchWorker(authedRequest("/api/audit-logs", { method: "POST", body: { action: "login" } }), env);
  await fetchWorker(authedRequest("/api/audit-logs", { method: "POST", body: { action: "error_fail" } }), env);

  const res = await fetchWorker(authedRequest("/api/audit-logs/stats"), env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.stats.total >= 2);
  assert.ok(json.stats.errors >= 1);
});

test("settings CRUD works", async () => {
  const env = makeEnv();
  await env.APP_DB.prepare("INSERT INTO USERS (?, ?, ?, ?, ?, ?)").bind("u1", "api@toque.local", "API", "", "admin", "{}").run();

  // Upsert settings
  const upsertRes = await fetchWorker(authedRequest("/api/settings", {
    method: "PUT",
    body: { settings: { "captcha.provider": "capmonster", "nusuk.activeEntityId": "525513" } },
  }), env);
  assert.equal(upsertRes.status, 200);
  const upsertJson = await upsertRes.json();
  assert.equal(upsertJson.count, 2);

  // List settings
  const listRes = await fetchWorker(authedRequest("/api/settings"), env);
  const listJson = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.ok(listJson.settings["captcha.provider"]);

  // Get single setting
  const getRes = await fetchWorker(authedRequest("/api/settings/captcha.provider"), env);
  const getJson = await getRes.json();
  assert.equal(getRes.status, 200);
  assert.equal(getJson.key, "captcha.provider");

  // Delete setting
  const delRes = await fetchWorker(authedRequest("/api/settings/captcha.provider", { method: "DELETE" }), env);
  assert.equal(delRes.status, 200);
});

test("viewer cannot access admin endpoints", async () => {
  const env = makeEnv();
  // Create a viewer user for the API token
  await env.APP_DB.prepare("INSERT INTO USERS (?, ?, ?, ?, ?, ?)").bind("v1", "api@toque.local", "Viewer", "", "viewer", "{}").run();

  const res = await fetchWorker(authedRequest("/api/users", { method: "POST", body: { email: "x@y.z" } }), env);
  assert.equal(res.status, 403);
});

test("returns 404 for unknown routes", async () => {
  const env = makeEnv();
  const res = await fetchWorker(authedRequest("/unknown"), env);
  assert.equal(res.status, 404);
});
