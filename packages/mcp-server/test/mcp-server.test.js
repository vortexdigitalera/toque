import { test } from "node:test";
import assert from "node:assert/strict";

import mcpServer, { TOOLS, handleRpc, authenticate } from "../src/index.js";

// ─── Fake service bindings ──────────────────────────────────────────

function createFakeWorker(responses = []) {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method !== "GET" && request.method !== "HEAD"
        ? await request.text().catch(() => null)
        : null;
      calls.push({ method: request.method, pathname: url.pathname, search: url.search, body });
      const match = responses.find((r) => !r.pathname || r.pathname === url.pathname);
      if (match) {
        return new Response(JSON.stringify(match.response), {
          status: match.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, default: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    AUTHA_WORKER: createFakeWorker([{ pathname: "/api/entity/525513/context", response: { ok: true, entityId: "525513", auth: { token: "Bearer test-token" } } }]),
    APP_WORKER: createFakeWorker([{ pathname: "/api/me", response: { ok: true, user: { email: "admin@toque.test", role: "super_admin" } } }]),
    TOQUE_WORKER: createFakeWorker([{ pathname: "/health", response: { ok: true, container: "running" } }]),
    AUTHA_API_TOKEN: "test-autha-token",
    APP_API_TOKEN: "test-app-token",
    WORKER_API_TOKEN: "test-worker-token",
    MCP_API_TOKEN: "test-mcp-token",
    ...overrides,
  };
}

function rpcRequest(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

// ─── Protocol tests ─────────────────────────────────────────────────

test("mcp: initialize returns protocol version and server info", async () => {
  const result = await handleRpc(rpcRequest("initialize", {}), makeEnv());
  assert.equal(result.jsonrpc, "2.0");
  assert.equal(result.id, 1);
  assert.equal(result.result.protocolVersion, "2025-06-18");
  assert.equal(result.result.serverInfo.name, "toque-mcp-server");
  assert.ok(result.result.capabilities.tools, "should advertise tools capability");
});

test("mcp: ping returns empty result", async () => {
  const result = await handleRpc(rpcRequest("ping", {}), makeEnv());
  assert.deepEqual(result.result, {});
});

test("mcp: tools/list returns all tool definitions", async () => {
  const result = await handleRpc(rpcRequest("tools/list", {}), makeEnv());
  assert.ok(Array.isArray(result.result.tools));
  assert.equal(result.result.tools.length, TOOLS.length);
  // Verify each tool has required fields
  for (const tool of result.result.tools) {
    assert.ok(tool.name, "tool should have a name");
    assert.ok(tool.description, "tool should have a description");
    assert.ok(tool.inputSchema, "tool should have an inputSchema");
  }
});

test("mcp: unknown method returns -32601 error", async () => {
  const result = await handleRpc(rpcRequest("nonexistent/method", {}), makeEnv());
  assert.equal(result.error.code, -32601);
  assert.match(result.error.message, /Method not found/);
});

test("mcp: notification (no id) returns undefined (no response)", async () => {
  const result = await handleRpc({ jsonrpc: "2.0", method: "initialized" }, makeEnv());
  assert.equal(result, undefined);
});

test("mcp: batch request returns array of results", async () => {
  const batch = [
    rpcRequest("ping", {}, 1),
    rpcRequest("ping", {}, 2),
  ];
  const result = await handleRpc(batch, makeEnv());
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 1);
  assert.equal(result[1].id, 2);
});

// ─── Tool call tests ────────────────────────────────────────────────

test("mcp: tools/call with unknown tool returns -32602 error", async () => {
  const result = await handleRpc(rpcRequest("tools/call", { name: "nonexistent_tool", arguments: {} }), makeEnv());
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /Unknown tool/);
});

test("mcp: get_entity_context calls autha-worker with correct path", async () => {
  const env = makeEnv();
  const result = await handleRpc(rpcRequest("tools/call", {
    name: "get_entity_context",
    arguments: { entityId: "525513" },
  }), env);
  assert.equal(result.jsonrpc, "2.0");
  assert.ok(result.result.content[0].text);
  const parsed = JSON.parse(result.result.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entityId, "525513");
  // Verify the autha-worker was called with the right path
  assert.equal(env.AUTHA_WORKER.calls[0].pathname, "/api/entity/525513/context");
  assert.ok(env.AUTHA_WORKER.calls[0].search.includes("systemUserId=default"));
});

test("mcp: get_entity_context passes systemUserId when provided", async () => {
  const env = makeEnv();
  await handleRpc(rpcRequest("tools/call", {
    name: "get_entity_context",
    arguments: { entityId: "525513", systemUserId: "user-123" },
  }), env);
  assert.ok(env.AUTHA_WORKER.calls[0].search.includes("systemUserId=user-123"));
});

test("mcp: get_current_user calls app-worker /api/me", async () => {
  const env = makeEnv();
  const result = await handleRpc(rpcRequest("tools/call", {
    name: "get_current_user",
    arguments: {},
  }), env);
  const parsed = JSON.parse(result.result.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.user.email, "admin@toque.test");
  assert.equal(env.APP_WORKER.calls[0].pathname, "/api/me");
});

test("mcp: get_current_user forwards CF Access JWT when provided", async () => {
  const env = makeEnv();
  await handleRpc(rpcRequest("tools/call", {
    name: "get_current_user",
    arguments: { cfAccessJwt: "test-jwt-abc" },
  }), env);
  // The app-worker fake doesn't check headers, but we verify the call was made
  assert.equal(env.APP_WORKER.calls[0].pathname, "/api/me");
});

test("mcp: list_audit_logs passes query params", async () => {
  const env = makeEnv();
  await handleRpc(rpcRequest("tools/call", {
    name: "list_audit_logs",
    arguments: { limit: 10, action: "visa_send" },
  }), env);
  const call = env.APP_WORKER.calls[0];
  assert.equal(call.pathname, "/api/audit-logs");
  assert.ok(call.search.includes("limit=10"));
  assert.ok(call.search.includes("action=visa_send"));
});

test("mcp: create_audit_log sends POST with body", async () => {
  const env = makeEnv();
  await handleRpc(rpcRequest("tools/call", {
    name: "create_audit_log",
    arguments: { action: "panel_access", panel: "send-visa", details: { status: "ok" } },
  }), env);
  const call = env.APP_WORKER.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.pathname, "/api/audit-logs");
  const body = JSON.parse(call.body);
  assert.equal(body.action, "panel_access");
  assert.equal(body.panel, "send-visa");
});

test("mcp: upsert_settings sends PUT with settings map", async () => {
  const env = makeEnv();
  await handleRpc(rpcRequest("tools/call", {
    name: "upsert_settings",
    arguments: { settings: { "captcha.provider": "capmonster" } },
  }), env);
  const call = env.APP_WORKER.calls[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.pathname, "/api/settings");
  const body = JSON.parse(call.body);
  assert.equal(body.settings["captcha.provider"], "capmonster");
});

test("mcp: trigger_nusuk_request calls toque Worker /cmd endpoint", async () => {
  const env = makeEnv();
  const result = await handleRpc(rpcRequest("tools/call", {
    name: "trigger_nusuk_request",
    arguments: { requestName: "groupsList", entityId: "525513" },
  }), env);
  assert.ok(result.result.content[0].text);
  // Verify the toque Worker was called
  assert.equal(env.TOQUE_WORKER.calls[0].pathname, "/cmd/groupsList");
  assert.ok(env.TOQUE_WORKER.calls[0].search.includes("entityId=525513"));
  assert.ok(env.TOQUE_WORKER.calls[0].search.includes("cacheBust=true"));
});

test("mcp: trigger_nusuk_request with POST method sends body", async () => {
  const env = makeEnv();
  await handleRpc(rpcRequest("tools/call", {
    name: "trigger_nusuk_request",
    arguments: {
      requestName: "visaSend",
      entityId: "525513",
      method: "POST",
      body: { groupId: "12345" },
    },
  }), env);
  const call = env.TOQUE_WORKER.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.pathname, "/cmd/visaSend");
  const body = JSON.parse(call.body);
  assert.equal(body.groupId, "12345");
});

test("mcp: get_toque_health calls toque Worker /health", async () => {
  const env = makeEnv();
  const result = await handleRpc(rpcRequest("tools/call", {
    name: "get_toque_health",
    arguments: {},
  }), env);
  const parsed = JSON.parse(result.result.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(env.TOQUE_WORKER.calls[0].pathname, "/health");
});

test("mcp: tool handler error returns isError result (not JSON-RPC error)", async () => {
  const env = makeEnv({ AUTHA_WORKER: null });
  const result = await handleRpc(rpcRequest("tools/call", {
    name: "get_entity_context",
    arguments: { entityId: "525513" },
  }), env);
  // Should return a result with isError: true, not a JSON-RPC error
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Service binding not configured/);
});

// ─── Auth tests ─────────────────────────────────────────────────────

test("mcp: authenticate returns true when no token configured (open mode)", () => {
  const req = new Request("https://mcp.test/", { headers: {} });
  assert.equal(authenticate(req, {}), true);
});

test("mcp: authenticate accepts valid Bearer token", () => {
  const req = new Request("https://mcp.test/", {
    headers: { "Authorization": "Bearer test-mcp-token" },
  });
  assert.equal(authenticate(req, { MCP_API_TOKEN: "test-mcp-token" }), true);
});

test("mcp: authenticate rejects wrong token", () => {
  const req = new Request("https://mcp.test/", {
    headers: { "Authorization": "Bearer wrong-token" },
  });
  assert.equal(authenticate(req, { MCP_API_TOKEN: "test-mcp-token" }), false);
});

test("mcp: authenticate accepts CF Access JWT when team domain configured", () => {
  const req = new Request("https://mcp.test/", {
    headers: { "Cf-Access-Jwt-Assertion": "some-jwt" },
  });
  assert.equal(authenticate(req, { CF_ACCESS_TEAM_DOMAIN: "toque.cloudflareaccess.com" }), true);
});

test("mcp: authenticate rejects when no credentials provided and token required", () => {
  const req = new Request("https://mcp.test/", { headers: {} });
  assert.equal(authenticate(req, { MCP_API_TOKEN: "test-mcp-token" }), false);
});

// ─── Worker fetch entry point tests ─────────────────────────────────

test("mcp: /health is always public", async () => {
  const res = await mcpServer.fetch(new Request("https://mcp.test/health"), {});
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.service, "toque-mcp-server");
  assert.equal(json.tools, TOOLS.length);
});

test("mcp: POST without auth returns 401 when token configured", async () => {
  const res = await mcpServer.fetch(new Request("https://mcp.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rpcRequest("ping", {})),
  }), { MCP_API_TOKEN: "secret" });
  assert.equal(res.status, 401);
});

test("mcp: POST with valid auth returns JSON-RPC response", async () => {
  const env = makeEnv();
  const res = await mcpServer.fetch(new Request("https://mcp.test/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer test-mcp-token",
    },
    body: JSON.stringify(rpcRequest("ping", {})),
  }), env);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.result, {});
});

test("mcp: POST with invalid JSON returns parse error", async () => {
  const res = await mcpServer.fetch(new Request("https://mcp.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json",
  }), {});
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, -32700);
});

test("mcp: GET returns server discovery info", async () => {
  const res = await mcpServer.fetch(new Request("https://mcp.test/"), {});
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.name, "toque-mcp-server");
  assert.equal(json.protocolVersion, "2025-06-18");
  assert.ok(Array.isArray(json.tools));
});

test("mcp: notification POST returns 202 with no body", async () => {
  const res = await mcpServer.fetch(new Request("https://mcp.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "initialized" }),
  }), {});
  assert.equal(res.status, 202);
});
