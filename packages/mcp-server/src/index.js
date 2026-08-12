/**
 * @toque/mcp-server — Model Context Protocol server for the toque platform.
 *
 * Exposes the toque platform's APIs as MCP tools so AI agents (Claude,
 * Copilot, etc.) can:
 *   - Query auth/captcha tokens from autha-worker
 *   - Manage users, audit logs, and settings in app-worker
 *   - Trigger Nusuk requests via the toque Worker
 *
 * Transport: Streamable HTTP (MCP 2025-06-18 spec, JSON-RPC 2.0).
 * Auth: Bearer token (MCP_API_TOKEN) or CF Access JWT.
 *
 * Service bindings (configured in wrangler.toml):
 *   - AUTHA_WORKER → autha-worker
 *   - APP_WORKER   → app-worker
 *   - TOQUE_WORKER → toque Worker (for Nusuk request triggers)
 */

// ─── Tool definitions ──────────────────────────────────────────────

/**
 * Each tool has: name, description, inputSchema (JSON Schema), and a handler
 * that receives (args, env) and returns a JSON-serializable result.
 *
 * Handlers call the downstream workers via service bindings (env.AUTHA_WORKER,
 * env.APP_WORKER, env.TOQUE_WORKER) — all in-network, no public round-trip.
 */

const TOOLS = [
  // ─── autha-worker: token & entity queries ─────────────────────────
  {
    name: "get_entity_context",
    description: "Get the latest auth token, captcha token, and entity context for a Nusuk entity. Use this to check what credentials are available for a given entity ID.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "The Nusuk entity ID (e.g. '525513')" },
        systemUserId: { type: "string", description: "Optional system user ID to filter by (default: 'default')" },
      },
      required: ["entityId"],
    },
    handler: async (args, env) => {
      const url = new URL(`/api/entity/${encodeURIComponent(args.entityId)}/context`, "https://autha-worker.internal");
      url.searchParams.set("systemUserId", args.systemUserId || "default");
      const res = await proxyFetch(env.AUTHA_WORKER, url, {
        headers: authHeaders(env),
      });
      return await res.json();
    },
  },
  {
    name: "get_user_context",
    description: "Get the latest auth and captcha context for a system user across all their entities.",
    inputSchema: {
      type: "object",
      properties: {
        systemUserId: { type: "string", description: "The system user ID" },
      },
      required: ["systemUserId"],
    },
    handler: async (args, env) => {
      const url = new URL(`/api/user/${encodeURIComponent(args.systemUserId)}/context`, "https://autha-worker.internal");
      const res = await proxyFetch(env.AUTHA_WORKER, url, {
        headers: authHeaders(env),
      });
      return await res.json();
    },
  },
  {
    name: "get_latest_token",
    description: "Get just the latest auth token for an entity (lighter than full context).",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "The Nusuk entity ID" },
      },
      required: ["entityId"],
    },
    handler: async (args, env) => {
      const url = new URL(`/entity/${encodeURIComponent(args.entityId)}/token/latest`, "https://autha-worker.internal");
      const res = await proxyFetch(env.AUTHA_WORKER, url, {
        headers: authHeaders(env),
      });
      return await res.json();
    },
  },
  {
    name: "list_records",
    description: "List stored records by key prefix from the autha-worker token store.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Key prefix to filter by (e.g. 'auth:', 'captcha:')" },
        limit: { type: "number", description: "Max records to return (default: 50, max: 200)", default: 50 },
      },
    },
    handler: async (args, env) => {
      const url = new URL("/records", "https://autha-worker.internal");
      if (args.prefix) url.searchParams.set("prefix", args.prefix);
      url.searchParams.set("limit", String(args.limit || 50));
      const res = await proxyFetch(env.AUTHA_WORKER, url, {
        headers: authHeaders(env),
      });
      return await res.json();
    },
  },
  {
    name: "list_entities",
    description: "List all known entity IDs that have stored tokens in the autha-worker.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => {
      const res = await proxyFetch(env.AUTHA_WORKER, new URL("/entities", "https://autha-worker.internal"), {
        headers: authHeaders(env),
      });
      return await res.json();
    },
  },
  {
    name: "get_autha_stats",
    description: "Get usage statistics from the autha-worker (record counts, entity counts, recent activity).",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => {
      const res = await proxyFetch(env.AUTHA_WORKER, new URL("/stats", "https://autha-worker.internal"), {
        headers: authHeaders(env),
      });
      return await res.json();
    },
  },

  // ─── app-worker: user management ──────────────────────────────────
  {
    name: "get_current_user",
    description: "Get the current user's profile. In CF Access mode, pass the JWT; in API mode, the token identifies the user.",
    inputSchema: {
      type: "object",
      properties: {
        cfAccessJwt: { type: "string", description: "CF Access JWT (Cf-Access-Jwt-Assertion). If omitted, uses API token auth." },
      },
    },
    handler: async (args, env) => {
      const headers = appHeaders(env, args.cfAccessJwt);
      const res = await proxyFetch(env.APP_WORKER, new URL("/api/me", "https://app-worker.internal"), { headers });
      return await res.json();
    },
  },
  {
    name: "list_users",
    description: "List all users in the platform (admin+ only).",
    inputSchema: {
      type: "object",
      properties: {
        cfAccessJwt: { type: "string", description: "CF Access JWT for auth" },
      },
    },
    handler: async (args, env) => {
      const headers = appHeaders(env, args.cfAccessJwt);
      const res = await proxyFetch(env.APP_WORKER, new URL("/api/users", "https://app-worker.internal"), { headers });
      return await res.json();
    },
  },
  {
    name: "create_user",
    description: "Create a new user in the platform (admin+ only).",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "User email" },
        fullName: { type: "string", description: "Full name" },
        role: { type: "string", enum: ["super_admin", "admin", "operator", "viewer"], description: "User role" },
        cfAccessJwt: { type: "string", description: "CF Access JWT for auth" },
      },
      required: ["email"],
    },
    handler: async (args, env) => {
      const headers = { ...appHeaders(env, args.cfAccessJwt), "Content-Type": "application/json" };
      const res = await proxyFetch(env.APP_WORKER, new URL("/api/users", "https://app-worker.internal"), {
        method: "POST",
        headers,
        body: JSON.stringify({ email: args.email, fullName: args.fullName, role: args.role }),
      });
      return await res.json();
    },
  },

  // ─── app-worker: audit logs ───────────────────────────────────────
  {
    name: "list_audit_logs",
    description: "List audit log entries with optional filters (action, panel, user, time range).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries (default: 50)", default: 50 },
        action: { type: "string", description: "Filter by action type" },
        panel: { type: "string", description: "Filter by panel name" },
        cfAccessJwt: { type: "string", description: "CF Access JWT for auth" },
      },
    },
    handler: async (args, env) => {
      const url = new URL("/api/audit-logs", "https://app-worker.internal");
      if (args.limit) url.searchParams.set("limit", String(args.limit));
      if (args.action) url.searchParams.set("action", args.action);
      if (args.panel) url.searchParams.set("panel", args.panel);
      const res = await proxyFetch(env.APP_WORKER, url, { headers: appHeaders(env, args.cfAccessJwt) });
      return await res.json();
    },
  },
  {
    name: "create_audit_log",
    description: "Create an audit log entry (records an action taken by an agent or user).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action type (e.g. 'panel_access', 'visa_send', 'config_change')" },
        panel: { type: "string", description: "Panel or module name" },
        details: { type: "object", description: "Arbitrary details about the action" },
        cfAccessJwt: { type: "string", description: "CF Access JWT for auth" },
      },
      required: ["action"],
    },
    handler: async (args, env) => {
      const headers = { ...appHeaders(env, args.cfAccessJwt), "Content-Type": "application/json" };
      const res = await proxyFetch(env.APP_WORKER, new URL("/api/audit-logs", "https://app-worker.internal"), {
        method: "POST",
        headers,
        body: JSON.stringify({ action: args.action, panel: args.panel, details: args.details }),
      });
      return await res.json();
    },
  },
  {
    name: "get_audit_stats",
    description: "Get aggregate audit metrics (error counts, action breakdowns) for the last 5 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        cfAccessJwt: { type: "string", description: "CF Access JWT for auth" },
      },
    },
    handler: async (args, env) => {
      const res = await proxyFetch(env.APP_WORKER, new URL("/api/audit-logs/stats", "https://app-worker.internal"), {
        headers: appHeaders(env, args.cfAccessJwt),
      });
      return await res.json();
    },
  },

  // ─── app-worker: settings ─────────────────────────────────────────
  {
    name: "list_settings",
    description: "List all platform settings stored in D1 (captcha provider, active entity, limits, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        cfAccessJwt: { type: "string", description: "CF Access JWT for auth" },
      },
    },
    handler: async (args, env) => {
      const res = await proxyFetch(env.APP_WORKER, new URL("/api/settings", "https://app-worker.internal"), {
        headers: appHeaders(env, args.cfAccessJwt),
      });
      return await res.json();
    },
  },
  {
    name: "get_setting",
    description: "Get a single platform setting by key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Setting key (e.g. 'captcha.provider')" },
        cfAccessJwt: { type: "string", description: "CF Access JWT for auth" },
      },
      required: ["key"],
    },
    handler: async (args, env) => {
      const res = await proxyFetch(env.APP_WORKER, new URL(`/api/settings/${encodeURIComponent(args.key)}`, "https://app-worker.internal"), {
        headers: appHeaders(env, args.cfAccessJwt),
      });
      return await res.json();
    },
  },
  {
    name: "upsert_settings",
    description: "Bulk upsert platform settings. Pass a key→value map of settings to update.",
    inputSchema: {
      type: "object",
      properties: {
        settings: { type: "object", description: "Map of setting key → value", additionalProperties: true },
        cfAccessJwt: { type: "string", description: "CF Access JWT for auth" },
      },
      required: ["settings"],
    },
    handler: async (args, env) => {
      const headers = { ...appHeaders(env, args.cfAccessJwt), "Content-Type": "application/json" };
      const res = await proxyFetch(env.APP_WORKER, new URL("/api/settings", "https://app-worker.internal"), {
        method: "PUT",
        headers,
        body: JSON.stringify({ settings: args.settings }),
      });
      return await res.json();
    },
  },

  // ─── toque Worker: Nusuk request trigger ──────────────────────────
  {
    name: "trigger_nusuk_request",
    description: "Trigger a Nusuk API request via the toque Worker. The Worker runs the request through the stealth browser container with the entity's stored auth token.",
    inputSchema: {
      type: "object",
      properties: {
        requestName: { type: "string", description: "Named request from the catalog (e.g. 'login', 'groupsList', 'visaSend')" },
        entityId: { type: "string", description: "Entity ID to use for auth context" },
        method: { type: "string", enum: ["GET", "POST"], description: "HTTP method (default: GET)" },
        body: { type: "object", description: "Request body for POST requests", additionalProperties: true },
        cacheBust: { type: "boolean", description: "Bypass browser cache (default: true)", default: true },
      },
      required: ["requestName", "entityId"],
    },
    handler: async (args, env) => {
      if (!env.TOQUE_WORKER) {
        return { ok: false, error: "TOQUE_WORKER service binding not configured" };
      }
      const url = new URL(`/cmd/${encodeURIComponent(args.requestName)}`, "https://toque-worker.internal");
      url.searchParams.set("entityId", args.entityId);
      if (args.cacheBust !== false) url.searchParams.set("cacheBust", "true");
      const method = args.method || "GET";
      const headers = { "Authorization": `Bearer ${env.WORKER_API_TOKEN || ""}` };
      let body = null;
      if (method === "POST" && args.body) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(args.body);
      }
      const res = await proxyFetch(env.TOQUE_WORKER, url, { method, headers, body });
      return await res.json();
    },
  },
  {
    name: "get_toque_health",
    description: "Check the health of the toque Worker and its container backend.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, env) => {
      if (!env.TOQUE_WORKER) {
        return { ok: false, error: "TOQUE_WORKER service binding not configured" };
      }
      const res = await proxyFetch(env.TOQUE_WORKER, new URL("/health", "https://toque-worker.internal"));
      return await res.json();
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────────

/** Build auth headers for autha-worker requests. */
function authHeaders(env) {
  const h = {};
  if (env.AUTHA_API_TOKEN) h["Authorization"] = `Bearer ${env.AUTHA_API_TOKEN}`;
  return h;
}

/** Build auth headers for app-worker requests (CF Access JWT or API token). */
function appHeaders(env, cfAccessJwt) {
  const h = {};
  if (cfAccessJwt) {
    h["Cf-Access-Jwt-Assertion"] = cfAccessJwt;
  } else if (env.APP_API_TOKEN) {
    h["Authorization"] = `Bearer ${env.APP_API_TOKEN}`;
  }
  return h;
}

/** Proxy a fetch call through a service binding. Throws if binding is missing. */
async function proxyFetch(binding, url, init = {}) {
  if (!binding) {
    throw new Error("Service binding not configured");
  }
  const hasBody = init.body != null;
  const req = new Request(url, {
    method: init.method || "GET",
    headers: init.headers || {},
    body: hasBody ? init.body : null,
    redirect: "manual",
    ...(hasBody ? { duplex: "half" } : {}),
  });
  return binding.fetch(req);
}

// ─── MCP protocol (JSON-RPC 2.0 over HTTP) ──────────────────────────

/** Handle a single JSON-RPC 2.0 request. */
async function handleRpc(request, env) {
  // Batch request
  if (Array.isArray(request)) {
    const results = await Promise.all(request.map((r) => handleSingle(r, env)));
    return results.filter((r) => r !== undefined);
  }
  return handleSingle(request, env);
}

async function handleSingle(msg, env) {
  if (!msg || typeof msg !== "object") {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const { id, method, params } = msg;

  // Notification (no id) — no response
  if (id === undefined && method) {
    return undefined;
  }

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {
            tools: {},
            logging: {},
          },
          serverInfo: {
            name: "toque-mcp-server",
            version: "1.0.0",
          },
        },
      };

    case "initialized":
      // Acknowledgment notification — no response needed
      return undefined;

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case "tools/call": {
      const toolName = params?.name;
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      try {
        const args = params?.arguments || {};
        const result = await tool.handler(args, env);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          },
        };
      }
    }

    case "logging/setLevel":
      // Accept but no-op
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

// ─── Auth ────────────────────────────────────────────────────────────

function authenticate(request, env) {
  // If no token configured, allow all (open mode — dev only)
  if (!env.MCP_API_TOKEN && !env.CF_ACCESS_TEAM_DOMAIN) return true;

  const auth = request.headers.get("Authorization") || "";
  if (env.MCP_API_TOKEN && auth === `Bearer ${env.MCP_API_TOKEN}`) return true;

  // CF Access JWT
  const cfJwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (cfJwt && env.CF_ACCESS_TEAM_DOMAIN) return true;

  return false;
}

// ─── Worker entry point ──────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Health check (always public)
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "toque-mcp-server", tools: TOOLS.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Auth
    if (!authenticate(request, env)) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="toque-mcp"' },
      });
    }

    // MCP endpoint — accepts POST with JSON-RPC body
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (body === null) {
        return new Response(JSON.stringify(jsonRpcError(null, -32700, "Parse error")), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await handleRpc(body, env);
      // For notifications, result may be undefined → return 202
      if (result === undefined) {
        return new Response(null, { status: 202 });
      }
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET on the MCP endpoint — return server info (discovery)
    if (request.method === "GET") {
      return new Response(JSON.stringify({
        name: "toque-mcp-server",
        version: "1.0.0",
        protocolVersion: "2025-06-18",
        tools: TOOLS.map((t) => t.name),
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "GET, POST" },
    });
  },
};

// Export tools for testing
export { TOOLS, handleRpc, authenticate };
