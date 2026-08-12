/**
 * toque-ui Worker — serves the Next.js static export and proxies all
 * API calls to the main toque Worker via a service binding (internal mesh).
 *
 * Architecture:
 *   Browser → toque-ui Worker → (service binding) → toque Worker → mesh
 *
 * The toque-ui Worker serves static assets (HTML/CSS/JS) from the ASSETS
 * binding (the ./public directory, populated by `node build.js` which copies
 * the Next.js static export from packages/toqueui/out).
 *
 * API calls from the browser go to /api/* on this Worker, which proxies them
 * to the toque Worker via the TOQUE_WORKER service binding — no public
 * internet round-trip. The Worker injects the CF Access JWT or API token
 * from the incoming request's Authorization header.
 *
 * Routes:
 *   GET  /                  → index.html (dashboard)
 *   GET  /entities          → entities.html (SPA fallback)
 *   GET  /audit             → audit.html
 *   GET  /settings          → settings.html
 *   GET  /users             → users.html
 *   ANY  /api/*             → proxy to toque Worker (service binding)
 *   ANY  /autha/*           → proxy to toque Worker /autha/*
 *   ANY  /app/*             → proxy to toque Worker /app/*
 *   ANY  /mcp/*             → proxy to toque Worker /mcp/*
 *   GET  /_next/*           → static assets (CSS, JS chunks)
 *   GET  /health            → { ok: true, service: "toque-ui" }
 */

import { env } from "cloudflare:workers";

// ─── Health check ─────────────────────────────────────────────────────
export function healthResponse() {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "toque-ui",
      version: "1.0.0",
      mesh: "toque-ui → toque → {autha-worker, app-worker, mcp-server, container}",
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ─── Proxy to toque Worker via service binding ────────────────────────

/**
 * Proxy a request to the toque Worker via the TOQUE_WORKER service binding.
 *
 * The service binding sends the request directly within Cloudflare's
 * network — no public internet round-trip. We preserve the method, body,
 * headers, and path. The toque Worker handles auth (CF Access JWT or
 * API key) on its end.
 *
 * @param {Request} request — the incoming request
 * @param {string} path — the path to forward to (e.g. "/health", "/autha/entities")
 * @returns {Promise<Response>}
 */
async function proxyToToque(request, path) {
  if (!env.TOQUE_WORKER) {
    return new Response(
      JSON.stringify({ ok: false, error: "TOQUE_WORKER service binding not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Build the target URL — use a fake host since service bindings ignore it
  const url = new URL(request.url);
  const targetUrl = new URL(path, "https://toque-worker.internal");
  targetUrl.search = url.search;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const headers = new Headers(request.headers);

  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    redirect: "manual",
    ...(hasBody ? { duplex: "half" } : {}),
  });

  return env.TOQUE_WORKER.fetch(proxyRequest);
}

// ─── Main fetch handler ──────────────────────────────────────────────

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;

    // --- Health check ---
    if (pathname === "/health") {
      return healthResponse();
    }

    // --- API proxy routes → toque Worker via service binding ---
    // All API calls from the dashboard go through these proxy routes,
    // which forward to the toque Worker internally (no public internet).
    if (
      pathname.startsWith("/api/") ||
      pathname.startsWith("/autha/") ||
      pathname.startsWith("/app/") ||
      pathname.startsWith("/mcp/") ||
      pathname === "/health" ||
      pathname === "/help"
    ) {
      // Strip /api/ prefix — /api/health → /health, /api/autha/entities → /autha/entities
      let targetPath = pathname;
      if (pathname.startsWith("/api/")) {
        targetPath = pathname.replace(/^\/api/, "");
      }
      return proxyToToque(request, targetPath);
    }

    // --- Static assets (HTML, CSS, JS, images) ---
    // The ASSETS binding serves files from ./public with SPA fallback.
    // Next.js static export puts files as /index.html, /entities.html, etc.
    // The assets binding with not_found_handling: "single-page-application"
    // handles clean URLs automatically (e.g. /entities → /entities.html).
    return env.ASSETS.fetch(request);
  },
};
