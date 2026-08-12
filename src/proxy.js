/**
 * Service-binding proxy functions for the toque Worker.
 *
 * Extracted from src/index.js so they can be unit-tested without
 * importing @cloudflare/containers or cloudflare:workers.
 *
 * These proxy /autha/*, /app/*, and /mcp/* requests to the autha-worker,
 * app-worker, and mcp-server via Cloudflare service bindings (Worker-to-Worker mesh).
 */

import { jsonResponse } from "./utils.js";

/**
 * Proxy /autha/* requests to the autha-worker via a service binding.
 *
 * The service binding (env.AUTHA_WORKER) sends requests directly within
 * Cloudflare's network — no public internet round-trip. The /autha/ prefix
 * is stripped, so `/autha/api/entity/123/context` becomes
 * `/api/entity/123/context` on the autha-worker.
 *
 * The WORKER_API_TOKEN is injected automatically from the Worker's secret,
 * so the container doesn't need to send it over the network. If the
 * incoming request already has an Authorization header, it's preserved.
 */
export function proxyToAuthaWorker(request, url, env) {
  if (!env.AUTHA_WORKER) {
    return jsonResponse(500, {
      ok: false,
      error: "AUTHA_WORKER service binding not configured",
    });
  }

  // Strip the /autha/ prefix
  const targetPath = url.pathname.replace(/^\/autha/, "") + url.search;

  // Build the forwarded request — preserve method, body, and most headers
  const headers = new Headers(request.headers);
  // Inject the API token if not already present
  if (!headers.has("Authorization") && env.WORKER_API_TOKEN) {
    headers.set("Authorization", `Bearer ${env.WORKER_API_TOKEN}`);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const proxyRequest = new Request(
    new URL(targetPath, "https://autha-worker.internal"),
    {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    }
  );

  return env.AUTHA_WORKER.fetch(proxyRequest);
}

/**
 * Proxy /app/* requests to the app-worker via a service binding.
 *
 * The service binding (env.APP_WORKER) sends requests directly within
 * Cloudflare's network. The /app/ prefix is stripped, so
 * `/app/api/users` becomes `/api/users` on the app-worker.
 *
 * The APP_API_TOKEN is injected automatically from the Worker's secret.
 * If the incoming request already has an Authorization header (e.g. a
 * CF Access JWT from the dashboard), it's preserved.
 */
export function proxyToAppWorker(request, url, env) {
  if (!env.APP_WORKER) {
    return jsonResponse(500, {
      ok: false,
      error: "APP_WORKER service binding not configured",
    });
  }

  // Strip the /app/ prefix
  const targetPath = url.pathname.replace(/^\/app/, "") + url.search;

  // Build the forwarded request — preserve method, body, and most headers
  const headers = new Headers(request.headers);
  // Inject the API token if not already present
  if (!headers.has("Authorization") && env.APP_API_TOKEN) {
    headers.set("Authorization", `Bearer ${env.APP_API_TOKEN}`);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const proxyRequest = new Request(
    new URL(targetPath, "https://app-worker.internal"),
    {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    }
  );

  return env.APP_WORKER.fetch(proxyRequest);
}

/**
 * Proxy /ui/* requests to the toque-ui Worker via a service binding.
 *
 * The service binding (env.TOQUE_UI) sends requests directly within
 * Cloudflare's network. The /ui/ prefix is stripped, so `/ui/` becomes `/`
 * on the toque-ui Worker. This lets the dashboard be served from the main
 * toque Worker URL (e.g. https://toque.decloud.workers.dev/ui/) without
 * a separate public URL for the toque-ui Worker.
 *
 * The toque-ui Worker serves static assets (HTML/CSS/JS) and proxies
 * API calls back to this Worker via its own TOQUE_WORKER service binding.
 */
export function proxyToUiWorker(request, url, env) {
  if (!env.TOQUE_UI) {
    return jsonResponse(500, {
      ok: false,
      error: "TOQUE_UI service binding not configured",
    });
  }

  // Strip the /ui prefix — /ui/ → /, /ui/entities → /entities
  const targetPath = url.pathname.replace(/^\/ui/, "") + url.search;

  const headers = new Headers(request.headers);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const proxyRequest = new Request(
    new URL(targetPath || "/", "https://toque-ui.internal"),
    {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    }
  );

  return env.TOQUE_UI.fetch(proxyRequest);
}

/**
 * Proxy /mcp/* requests to the MCP server via a service binding.
 *
 * The service binding (env.MCP_SERVER) sends requests directly within
 * Cloudflare's network. The /mcp/ prefix is stripped, so
 * `/mcp/tools/list` becomes `/tools/list` on the MCP server.
 *
 * Auth is passed through (Bearer token or CF Access JWT) — the MCP server
 * handles its own authentication.
 */
export function proxyToMcpServer(request, url, env) {
  if (!env.MCP_SERVER) {
    return jsonResponse(500, {
      ok: false,
      error: "MCP_SERVER service binding not configured",
    });
  }

  // Strip the /mcp/ prefix
  const targetPath = url.pathname.replace(/^\/mcp/, "") + url.search;

  // Build the forwarded request — preserve method, body, and all headers
  const headers = new Headers(request.headers);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const proxyRequest = new Request(
    new URL(targetPath, "https://mcp-server.internal"),
    {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    }
  );

  return env.MCP_SERVER.fetch(proxyRequest);
}
