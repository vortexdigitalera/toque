import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

/**
 * End-to-end integration tests for the Cloudflare mesh.
 *
 * Tests the full workflow:
 *   1. autha-worker: signed upload → D1 → entity context query
 *   2. app-worker: CF Access JWT → auto-provision → user CRUD → audit log
 *   3. toque Worker: /autha/* proxy → autha-worker, /app/* proxy → app-worker
 *
 * These tests use fake service bindings to simulate the Cloudflare mesh
 * (Worker-to-Worker calls via env.AUTHA_WORKER.fetch() and env.APP_WORKER.fetch()).
 */

// ─── Import all three workers ────────────────────────────────────────

// NOTE: We import the proxy functions from src/proxy.js directly (not
// src/index.js) because src/index.js imports @cloudflare/containers and
// cloudflare:workers, which are not available in the Node.js test runtime.
// The proxy functions are pure (no Cloudflare-runtime deps) and are the
// only part of the toque Worker that participates in the mesh.
const { proxyToAuthaWorker, proxyToAppWorker, proxyToMcpServer, proxyToUiWorker } = await import("../src/proxy.js");
const authaWorker = (await import("../packages/autha-worker/src/index.js")).default;
const appWorker = (await import("../packages/app-worker/src/index.js")).default;
const mcpServer = (await import("../packages/mcp-server/src/index.js")).default;

// Minimal stand-in for the toque Worker's fetch handler for /autha/*,
// /app/*, and /mcp/* routes. Only the mesh-relevant paths are implemented.
const toqueWorker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/autha/")) {
      return proxyToAuthaWorker(request, url, env);
    }
    if (url.pathname.startsWith("/app/")) {
      return proxyToAppWorker(request, url, env);
    }
    if (url.pathname.startsWith("/mcp/")) {
      return proxyToMcpServer(request, url, env);
    }
    if (url.pathname.startsWith("/ui")) {
      return proxyToUiWorker(request, url, env);
    }
    return new Response(JSON.stringify({ ok: false, error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};

// ─── Fake D1 (shared pattern) ────────────────────────────────────────

function createFakeD1(schema = {}) {
  const tables = {};
  for (const name of Object.keys(schema)) {
    tables[name] = new Map();
  }
  return {
    tables,
    prepare(sql) {
      let b = [];
      const bind = (...args) => { b = args; return stmt; };
      const stmt = {
        bind,
        async run() {
          const s = sql.trim().toUpperCase();
          // Generic INSERT handler — detect table from SQL
          const tableMatch = s.match(/INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+(\w+)/);
          if (tableMatch) {
            const table = tableMatch[1].toLowerCase();
            if (!tables[table]) tables[table] = new Map();
            // Use first binding as key (convention: id or key)
            const key = b[0];
            const row = {};
            const cols = schema[table] || [];
            cols.forEach((col, i) => { row[col] = b[i]; });
            row.created_at = row.created_at || new Date().toISOString();
            row.updated_at = row.updated_at || new Date().toISOString();
            tables[table].set(key, row);
            return { success: true };
          }
          // DELETE
          const delMatch = s.match(/DELETE\s+FROM\s+(\w+)/);
          if (delMatch) {
            const table = delMatch[1].toLowerCase();
            if (tables[table]) tables[table].delete(b[0]);
            return { success: true };
          }
          return { success: true };
        },
        async all() {
          const s = sql.trim().toUpperCase();
          const fromMatch = s.match(/FROM\s+(\w+)/);
          if (fromMatch) {
            const table = fromMatch[1].toLowerCase();
            const rows = [...(tables[table]?.values() || [])];
            // Sort by created_at DESC if requested
            if (s.includes("ORDER BY")) {
              if (s.includes("CREATED_AT DESC") || s.includes("TIMESTAMP DESC")) {
                rows.sort((a, c) => (c.created_at || c.timestamp || "").toString().localeCompare((a.created_at || a.timestamp || "").toString()));
              } else if (s.includes("KEY")) {
                rows.sort((a, c) => a.key?.localeCompare(c.key || ""));
              }
            }
            // LIMIT
            const limitMatch = s.match(/LIMIT\s+(\d+)/);
            const limit = limitMatch ? Number(limitMatch[1]) : 100;
            return { results: rows.slice(0, limit) };
          }
          return { results: [] };
        },
        async first() {
          const s = sql.trim().toUpperCase();
          const fromMatch = s.match(/FROM\s+(\w+)/);
          if (fromMatch) {
            const table = fromMatch[1].toLowerCase();
            const rows = [...(tables[table]?.values() || [])];
            // WHERE email = ?
            if (s.includes("WHERE EMAIL")) {
              return rows.find((r) => r.email === b[0]) || null;
            }
            // WHERE id = ?
            if (s.includes("WHERE ID")) {
              return rows.find((r) => r.id === b[0]) || null;
            }
            // WHERE key = ?
            if (s.includes("WHERE KEY")) {
              return rows.find((r) => r.key === b[0]) || null;
            }
            // COUNT(*)
            if (s.includes("COUNT(*)")) {
              let filtered = rows;
              if (s.includes("CREATED_AT >=")) filtered = filtered.filter((r) => (r.created_at || "") >= b[0]);
              if (s.includes("ACTION LIKE")) filtered = filtered.filter((r) => /error|fail|denied/i.test(r.action || ""));
              return { count: filtered.length };
            }
            return rows[0] || null;
          }
          return null;
        },
      };
      return stmt;
    },
  };
}

// ─── Fake Service Bindings (mesh simulation) ────────────────────────

/**
 * Create a fake service binding that forwards requests to a worker's fetch handler.
 * This simulates Cloudflare's Worker-to-Worker service binding.
 */
function createFakeServiceBinding(workerModule, workerEnv) {
  return {
    async fetch(request) {
      return workerModule.fetch(request, workerEnv);
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

const AUTHA_API_TOKEN = "test-autha-token";
const AUTHA_SIGNING_SECRET = "test-signing-secret";
const APP_API_TOKEN = "test-app-token";
const ADMIN_EMAIL = "admin@toque.test";

function signBody(body, timestamp, secret) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function makeAuthaUpload(record, { headers = {} } = {}) {
  const body = JSON.stringify(record);
  const timestamp = String(record.timestamp || Date.now());
  const signature = signBody(body, timestamp, AUTHA_SIGNING_SECRET);
  return new Request("https://autha-worker.test/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AUTHA_API_TOKEN}`,
      "X-Autha-Timestamp": timestamp,
      "X-Autha-Signature": signature,
      "X-Autha-Action": record.action || "UNKNOWN",
      "X-Autha-Source": record.source || "test",
      "X-Autha-System-User-Id": record.systemUserId || "default",
      "entity-id": record.entityId || "",
      "activeentityid": record.activeEntityId || record.entityId || "",
      ...headers,
    },
    body,
  });
}

function makeCfAccessJwt(email, name, sub) {
  const header = btoa(JSON.stringify({ alg: "RS256" })).replace(/=/g, "");
  const payload = btoa(JSON.stringify({
    sub: sub || email,
    email,
    name: name || "Test User",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).replace(/=/g, "");
  return `${header}.${payload}.signature`;
}

// ─── Tests ──────────────────────────────────────────────────────────

test("mesh: autha-worker receives signed upload and serves context query", async () => {
  const authaEnv = {
    AUTHA_DB: createFakeD1({ records: ["key", "value", "timestamp", "system_user_id", "profile_tag", "entity_id", "action"] }),
    AUTHA_API_TOKEN: AUTHA_API_TOKEN,
    AUTHA_SIGNING_SECRET: AUTHA_SIGNING_SECRET,
  };

  // 1. Upload an auth token
  const record = {
    action: "NUSUK_AUTHA_AUTH_TOKEN",
    source: "extension",
    timestamp: Date.now(),
    entityId: "525513",
    activeEntityId: "525513",
    entityTypeId: "1",
    activeEntityTypeId: "1",
    token: "Bearer eyJhbGci.test.token",
    tokenType: 3,
  };
  const uploadRes = await authaWorker.fetch(makeAuthaUpload(record), authaEnv);
  assert.equal(uploadRes.status, 200, "upload should succeed");
  const uploadJson = await uploadRes.json();
  assert.equal(uploadJson.ok, true);
  assert.equal(uploadJson.entityId, "525513");

  // 2. Query entity context
  const ctxReq = new Request("https://autha-worker.test/api/entity/525513/context?systemUserId=default", {
    headers: { "Authorization": `Bearer ${AUTHA_API_TOKEN}` },
  });
  const ctxRes = await authaWorker.fetch(ctxReq, authaEnv);
  const ctxJson = await ctxRes.json();
  assert.equal(ctxRes.status, 200);
  assert.equal(ctxJson.entityId, "525513");
  assert.ok(ctxJson.auth, "auth token should be present");
  assert.equal(ctxJson.auth.token, "Bearer eyJhbGci.test.token");
});

test("mesh: app-worker auto-provisions user from CF Access JWT", async () => {
  const appEnv = {
    APP_DB: createFakeD1({ users: ["id", "email", "full_name", "avatar_url", "role", "permissions"], audit_logs: ["id", "user_id", "user_email", "action", "panel", "details", "ip_address"], settings: ["key", "value", "updated_at"], sessions: ["id", "user_id", "expires_at", "ip_address", "user_agent"] }),
    AUDIT_BROADCASTER: { idFromName: () => "x", get: () => ({ async fetch() { return new Response('{"ok":true}'); } }) },
    APP_API_TOKEN: APP_API_TOKEN,
    ADMIN_EMAIL,
  };

  // 1. First login — should auto-provision as super_admin
  const jwt = makeCfAccessJwt(ADMIN_EMAIL, "Admin User", "admin-sub-1");
  const meReq = new Request("https://app-worker.test/api/me", {
    headers: { "Cf-Access-Jwt-Assertion": jwt },
  });
  const meRes = await appWorker.fetch(meReq, appEnv);
  const meJson = await meRes.json();
  assert.equal(meRes.status, 200);
  assert.equal(meJson.user.email, ADMIN_EMAIL);
  assert.equal(meJson.user.role, "super_admin");

  // 2. Second user — should be viewer
  const jwt2 = makeCfAccessJwt("viewer@toque.test", "Viewer", "viewer-sub-1");
  const meReq2 = new Request("https://app-worker.test/api/me", {
    headers: { "Cf-Access-Jwt-Assertion": jwt2 },
  });
  const meRes2 = await appWorker.fetch(meReq2, appEnv);
  const meJson2 = await meRes2.json();
  assert.equal(meJson2.user.role, "viewer");
});

test("mesh: app-worker creates audit log and broadcasts to DO", async () => {
  const broadcasts = [];
  const appEnv = {
    APP_DB: createFakeD1({ users: ["id", "email", "full_name", "avatar_url", "role", "permissions"], audit_logs: ["id", "user_id", "user_email", "action", "panel", "details", "ip_address"], settings: ["key", "value", "updated_at"], sessions: ["id", "user_id", "expires_at", "ip_address", "user_agent"] }),
    AUDIT_BROADCASTER: {
      idFromName: () => "x",
      get: () => ({
        async fetch(url, init) {
          if (init?.method === "POST") broadcasts.push(JSON.parse(init.body));
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        },
      }),
    },
    APP_API_TOKEN: APP_API_TOKEN,
    ADMIN_EMAIL,
  };

  // Provision admin
  const jwt = makeCfAccessJwt(ADMIN_EMAIL, "Admin", "admin-1");
  await appWorker.fetch(new Request("https://app-worker.test/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), appEnv);

  // Create audit log
  const auditReq = new Request("https://app-worker.test/api/audit-logs", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": jwt, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "panel_access", panel: "send-visa", details: { status: "granted" } }),
  });
  const auditRes = await appWorker.fetch(auditReq, appEnv);
  assert.equal(auditRes.status, 201);
  assert.ok(broadcasts.length > 0, "should have broadcast to DO");
  assert.equal(broadcasts[0].action, "panel_access");
});

test("mesh: toque Worker proxies /autha/* to autha-worker via service binding", async () => {
  const authaEnv = {
    AUTHA_DB: createFakeD1({ records: ["key", "value", "timestamp", "system_user_id", "profile_tag", "entity_id", "action"] }),
    AUTHA_API_TOKEN: AUTHA_API_TOKEN,
    AUTHA_SIGNING_SECRET: AUTHA_SIGNING_SECRET,
  };

  // Upload a token to autha-worker
  await authaWorker.fetch(makeAuthaUpload({
    action: "NUSUK_AUTHA_AUTH_TOKEN",
    timestamp: Date.now(),
    entityId: "525513",
    token: "Bearer mesh-test-token",
    tokenType: 3,
  }), authaEnv);

  // Create toque Worker env with service binding to autha-worker
  const toqueEnv = {
    AUTHA_WORKER: createFakeServiceBinding(authaWorker, authaEnv),
    WORKER_API_TOKEN: AUTHA_API_TOKEN,
    // Skip container and auth for this test
    TOQUE_CONTAINER: null,
  };

  // Proxy request through toque Worker
  const proxyReq = new Request("https://toque.test/autha/api/entity/525513/context", {
    headers: {},
  });
  const proxyRes = await toqueWorker.fetch(proxyReq, toqueEnv);
  const proxyJson = await proxyRes.json();
  assert.equal(proxyRes.status, 200);
  assert.equal(proxyJson.entityId, "525513");
  assert.ok(proxyJson.auth, "auth should be present via proxy");
  assert.equal(proxyJson.auth.token, "Bearer mesh-test-token");
});

test("mesh: toque Worker proxies /app/* to app-worker via service binding", async () => {
  const appEnv = {
    APP_DB: createFakeD1({ users: ["id", "email", "full_name", "avatar_url", "role", "permissions"], audit_logs: ["id", "user_id", "user_email", "action", "panel", "details", "ip_address"], settings: ["key", "value", "updated_at"], sessions: ["id", "user_id", "expires_at", "ip_address", "user_agent"] }),
    AUDIT_BROADCASTER: { idFromName: () => "x", get: () => ({ async fetch() { return new Response('{"ok":true}'); } }) },
    APP_API_TOKEN: APP_API_TOKEN,
    ADMIN_EMAIL,
  };

  // Provision admin via app-worker directly
  const jwt = makeCfAccessJwt(ADMIN_EMAIL, "Admin", "admin-1");
  await appWorker.fetch(new Request("https://app-worker.test/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), appEnv);

  // Create toque Worker env with service binding to app-worker
  const toqueEnv = {
    APP_WORKER: createFakeServiceBinding(appWorker, appEnv),
    APP_API_TOKEN: APP_API_TOKEN,
    TOQUE_CONTAINER: null,
  };

  // Proxy /app/api/me through toque Worker
  const proxyReq = new Request("https://toque.test/app/api/me", {
    headers: { "Cf-Access-Jwt-Assertion": jwt },
  });
  const proxyRes = await toqueWorker.fetch(proxyReq, toqueEnv);
  const proxyJson = await proxyRes.json();
  assert.equal(proxyRes.status, 200);
  assert.equal(proxyJson.user.email, ADMIN_EMAIL);
  assert.equal(proxyJson.user.role, "super_admin");
});

test("mesh: full workflow — upload → proxy → context → app-worker audit", async () => {
  // This is the full mesh test:
  // 1. Extension uploads token to autha-worker (via toque Worker /autha/upload proxy)
  // 2. Container queries auth token via toque Worker /autha/api/entity/X/context
  // 3. Container logs audit event via toque Worker /app/api/audit-logs

  const authaEnv = {
    AUTHA_DB: createFakeD1({ records: ["key", "value", "timestamp", "system_user_id", "profile_tag", "entity_id", "action"] }),
    AUTHA_API_TOKEN: AUTHA_API_TOKEN,
    AUTHA_SIGNING_SECRET: AUTHA_SIGNING_SECRET,
  };
  const appEnv = {
    APP_DB: createFakeD1({ users: ["id", "email", "full_name", "avatar_url", "role", "permissions"], audit_logs: ["id", "user_id", "user_email", "action", "panel", "details", "ip_address"], settings: ["key", "value", "updated_at"], sessions: ["id", "user_id", "expires_at", "ip_address", "user_agent"] }),
    AUDIT_BROADCASTER: { idFromName: () => "x", get: () => ({ async fetch() { return new Response('{"ok":true}'); } }) },
    APP_API_TOKEN: APP_API_TOKEN,
    ADMIN_EMAIL,
  };

  // Provision admin in app-worker
  const jwt = makeCfAccessJwt(ADMIN_EMAIL, "Admin", "admin-1");
  await appWorker.fetch(new Request("https://app-worker.test/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), appEnv);

  const toqueEnv = {
    AUTHA_WORKER: createFakeServiceBinding(authaWorker, authaEnv),
    APP_WORKER: createFakeServiceBinding(appWorker, appEnv),
    WORKER_API_TOKEN: AUTHA_API_TOKEN,
    APP_API_TOKEN: APP_API_TOKEN,
    TOQUE_CONTAINER: null,
  };

  // Step 1: Upload token via toque Worker /autha/upload proxy
  const uploadReq = makeAuthaUpload({
    action: "NUSUK_AUTHA_AUTH_TOKEN",
    timestamp: Date.now(),
    entityId: "525513",
    token: "Bearer full-workflow-token",
    tokenType: 3,
  });
  // Rewrite URL to go through toque Worker's /autha/ proxy
  const proxiedUpload = new Request("https://toque.test/autha/upload", {
    method: "POST",
    headers: uploadReq.headers,
    body: await uploadReq.text(),
  });
  const uploadRes = await toqueWorker.fetch(proxiedUpload, toqueEnv);
  assert.equal(uploadRes.status, 200, "upload via proxy should succeed");
  const uploadJson = await uploadRes.json();
  assert.equal(uploadJson.entityId, "525513");

  // Step 2: Query context via toque Worker /autha/ proxy
  const ctxReq = new Request("https://toque.test/autha/api/entity/525513/context");
  const ctxRes = await toqueWorker.fetch(ctxReq, toqueEnv);
  const ctxJson = await ctxRes.json();
  assert.equal(ctxRes.status, 200);
  assert.equal(ctxJson.auth.token, "Bearer full-workflow-token");

  // Step 3: Log audit event via toque Worker /app/ proxy
  const auditReq = new Request("https://toque.test/app/api/audit-logs", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": jwt, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "visa_send",
      panel: "send-visa",
      details: { entityId: "525513", groupId: "12345", status: "success" },
    }),
  });
  const auditRes = await toqueWorker.fetch(auditReq, toqueEnv);
  assert.equal(auditRes.status, 201, "audit log via proxy should succeed");

  // Step 4: Verify audit log is retrievable via /app/ proxy
  const listReq = new Request("https://toque.test/app/api/audit-logs");
  const listRes = await toqueWorker.fetch(listReq, toqueEnv);
  const listJson = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.ok(listJson.logs.length > 0, "audit logs should be retrievable");
  assert.equal(listJson.logs[0].action, "visa_send");
});

test("mesh: settings sync from CLI → app-worker D1 via toque Worker proxy", async () => {
  const appEnv = {
    APP_DB: createFakeD1({ users: ["id", "email", "full_name", "avatar_url", "role", "permissions"], audit_logs: ["id", "user_id", "user_email", "action", "panel", "details", "ip_address"], settings: ["key", "value", "updated_at"], sessions: ["id", "user_id", "expires_at", "ip_address", "user_agent"] }),
    AUDIT_BROADCASTER: { idFromName: () => "x", get: () => ({ async fetch() { return new Response('{"ok":true}'); } }) },
    APP_API_TOKEN: APP_API_TOKEN,
    ADMIN_EMAIL,
  };

  // Provision admin
  const jwt = makeCfAccessJwt(ADMIN_EMAIL, "Admin", "admin-1");
  await appWorker.fetch(new Request("https://app-worker.test/api/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), appEnv);

  const toqueEnv = {
    APP_WORKER: createFakeServiceBinding(appWorker, appEnv),
    APP_API_TOKEN: APP_API_TOKEN,
    TOQUE_CONTAINER: null,
  };

  // Sync settings via /app/ proxy
  const syncReq = new Request("https://toque.test/app/api/settings", {
    method: "PUT",
    headers: { "Cf-Access-Jwt-Assertion": jwt, "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: {
        "captcha.provider": "capmonster",
        "nusuk.activeEntityId": "525513",
        "container.maxInstances": 3,
      },
    }),
  });
  const syncRes = await toqueWorker.fetch(syncReq, toqueEnv);
  const syncJson = await syncRes.json();
  assert.equal(syncRes.status, 200);
  assert.equal(syncJson.count, 3);

  // Verify settings are retrievable
  const getReq = new Request("https://toque.test/app/api/settings");
  const getRes = await toqueWorker.fetch(getReq, toqueEnv);
  const getJson = await getRes.json();
  assert.equal(getRes.status, 200);
  assert.ok(getJson.settings["captcha.provider"], "settings should be retrievable via proxy");
});

test("mesh: toque Worker proxies /mcp/* to MCP server — tools/list", async () => {
  // Create a fake MCP server service binding that delegates to the real
  // mcpServer handler, which in turn calls fake autha/app/toque bindings.
  const authaEnv = {
    AUTHA_DB: createFakeD1({ records: ["key", "value", "timestamp", "system_user_id", "profile_tag", "entity_id", "action"] }),
    AUTHA_API_TOKEN: AUTHA_API_TOKEN,
    AUTHA_SIGNING_SECRET: AUTHA_SIGNING_SECRET,
  };
  const mcpEnv = {
    AUTHA_WORKER: createFakeServiceBinding(authaWorker, authaEnv),
    APP_WORKER: createFakeServiceBinding(appWorker, {
      APP_DB: createFakeD1({ users: ["id", "email", "full_name", "avatar_url", "role", "permissions"], audit_logs: ["id", "user_id", "user_email", "action", "panel", "details", "ip_address"], settings: ["key", "value", "updated_at"], sessions: ["id", "user_id", "expires_at", "ip_address", "user_agent"] }),
      AUDIT_BROADCASTER: { idFromName: () => "x", get: () => ({ async fetch() { return new Response('{"ok":true}'); } }) },
      APP_API_TOKEN: APP_API_TOKEN,
      ADMIN_EMAIL,
    }),
    TOQUE_WORKER: createFakeServiceBinding({ fetch: async () => new Response('{"ok":true}') }, {}),
    AUTHA_API_TOKEN: AUTHA_API_TOKEN,
    APP_API_TOKEN: APP_API_TOKEN,
    WORKER_API_TOKEN: AUTHA_API_TOKEN,
    MCP_API_TOKEN: "test-mcp-token",
  };

  // Wrap mcpServer as a fake service binding
  const mcpBinding = {
    async fetch(request) {
      return mcpServer.fetch(request, mcpEnv);
    },
  };

  const toqueEnv = {
    MCP_SERVER: mcpBinding,
    TOQUE_CONTAINER: null,
  };

  // 1. MCP tools/list via toque Worker /mcp/ proxy
  const listReq = new Request("https://toque.test/mcp/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer test-mcp-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const listRes = await toqueWorker.fetch(listReq, toqueEnv);
  const listJson = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.equal(listJson.jsonrpc, "2.0");
  assert.ok(listJson.result.tools.length > 0, "MCP server should expose tools");

  // 2. MCP tools/call — get_entity_context via the full mesh:
  //    toque Worker /mcp/ → MCP server → autha-worker → D1
  const uploadRes = await authaWorker.fetch(makeAuthaUpload({
    action: "NUSUK_AUTHA_AUTH_TOKEN",
    timestamp: Date.now(),
    entityId: "525513",
    token: "Bearer mcp-mesh-token",
    tokenType: 3,
  }), authaEnv);
  assert.equal(uploadRes.status, 200);

  const callReq = new Request("https://toque.test/mcp/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer test-mcp-token" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_entity_context", arguments: { entityId: "525513" } },
    }),
  });
  const callRes = await toqueWorker.fetch(callReq, toqueEnv);
  const callJson = await callRes.json();
  assert.equal(callRes.status, 200);
  assert.equal(callJson.jsonrpc, "2.0");
  assert.ok(callJson.result.content[0].text);
  const toolResult = JSON.parse(callJson.result.content[0].text);
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.entityId, "525513");
  assert.equal(toolResult.auth.token, "Bearer mcp-mesh-token");
});

// ─── UI Worker proxy test ────────────────────────────────────────────

test("toque Worker /ui/* proxy → toque-ui Worker (serves static assets)", async () => {
  // Fake toque-ui Worker that serves static assets
  const fakeUiWorker = {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, service: "toque-ui" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/" || url.pathname === "") {
        return new Response("<!DOCTYPE html><html><head><title>Toque Dashboard</title></head><body>Dashboard</body></html>", {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.pathname === "/entities") {
        return new Response("<!DOCTYPE html><html><head><title>Entities</title></head><body>Entities</body></html>", {
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  };

  const toqueEnv = {
    TOQUE_UI: fakeUiWorker,
  };

  // Test /ui/ → / (index.html)
  const indexReq = new Request("https://toque.test/ui/");
  const indexRes = await toqueWorker.fetch(indexReq, toqueEnv);
  assert.equal(indexRes.status, 200);
  const indexHtml = await indexRes.text();
  assert.ok(indexHtml.includes("Toque Dashboard"));

  // Test /ui/entities → /entities
  const entitiesReq = new Request("https://toque.test/ui/entities");
  const entitiesRes = await toqueWorker.fetch(entitiesReq, toqueEnv);
  assert.equal(entitiesRes.status, 200);
  const entitiesHtml = await entitiesRes.text();
  assert.ok(entitiesHtml.includes("Entities"));

  // Test /ui/health → /health (UI Worker's own health)
  const healthReq = new Request("https://toque.test/ui/health");
  const healthRes = await toqueWorker.fetch(healthReq, toqueEnv);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.service, "toque-ui");
});

test("proxyToUiWorker returns 500 when TOQUE_UI binding is missing", async () => {
  const req = new Request("https://toque.test/ui/");
  const url = new URL(req.url);
  const res = await proxyToUiWorker(req, url, {});
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.ok(json.error.includes("TOQUE_UI service binding not configured"));
});
