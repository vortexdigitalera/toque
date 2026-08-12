/**
 * API client for the toque platform mesh.
 *
 * All requests go through the toque Worker's proxy routes:
 *   /app/*   → app-worker (users, audit logs, settings)
 *   /autha/* → autha-worker (tokens, entities)
 *   /mcp/*   → MCP server (AI agent tools)
 *
 * In production (served by the toque-ui Worker), we use relative /api/
 * paths which the toque-ui Worker proxies to the toque Worker via a
 * service binding (internal mesh — no public internet). In dev (next
 * dev), the Next.js rewrites proxy these to the dev Worker.
 *
 * Auth: CF Access JWT (injected by Cloudflare Access in production) or
 * API token via the Authorization header.
 */

import type {
  UserProfile,
  AuditLog,
  AuthContext,
  AuthaEntitiesResponse,
  ToqueResponse,
} from "@toque/shared";

// ─── Base fetch with auth ────────────────────────────────────────────

/**
 * In dev (next dev), we use the Next.js rewrites to proxy API calls
 * to the toque Worker (avoids CORS).
 * In production (served by the toque-ui Worker), we use relative /api/
 * paths which the toque-ui Worker proxies to the toque Worker via a
 * service binding (internal mesh — no public internet round-trip).
 */
const IS_DEV = typeof window !== "undefined" && window.location.hostname === "localhost";

// All API calls go through relative /api/ paths in production.
// The toque-ui Worker proxies these to the toque Worker via service binding.
const API_BASE = IS_DEV ? "/api/proxy" : "/api";
const APP_BASE = IS_DEV ? "/api/proxy-app" : "/api/app";
const AUTHA_BASE = IS_DEV ? "/api/proxy-autha" : "/api/autha";

/** Get the CF Access JWT from the cookie (set by Cloudflare Access). */
function getCfAccessJwt(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

/** Get the API token from localStorage (for non-Access auth). */
function getApiToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem("toque_api_token");
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const jwt = getCfAccessJwt();
  if (jwt) {
    headers["Cf-Access-Jwt-Assertion"] = jwt;
  } else {
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function apiFetch<T>(
  base: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });
  return res.json() as Promise<T>;
}

// ─── App-worker: users ───────────────────────────────────────────────

export async function getCurrentUser(): Promise<{ ok: boolean; user?: UserProfile; error?: string }> {
  return apiFetch(APP_BASE, "/api/me");
}

export async function listUsers(): Promise<{ ok: boolean; users?: UserProfile[]; error?: string }> {
  return apiFetch(APP_BASE, "/api/users");
}

export async function createUser(email: string, fullName: string, role: string): Promise<{ ok: boolean; user?: UserProfile; error?: string }> {
  return apiFetch(APP_BASE, "/api/users", {
    method: "POST",
    body: JSON.stringify({ email, fullName, role }),
  });
}

export async function updateUser(id: string, updates: Record<string, unknown>): Promise<{ ok: boolean; user?: UserProfile; error?: string }> {
  return apiFetch(APP_BASE, `/api/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteUser(id: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch(APP_BASE, `/api/users/${id}`, { method: "DELETE" });
}

// ─── App-worker: audit logs ─────────────────────────────────────────

export async function listAuditLogs(params?: { limit?: number; action?: string; panel?: string }): Promise<{ ok: boolean; logs?: AuditLog[]; error?: string }> {
  const search = new URLSearchParams();
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.action) search.set("action", params.action);
  if (params?.panel) search.set("panel", params.panel);
  const qs = search.toString();
  return apiFetch(APP_BASE, `/api/audit-logs${qs ? `?${qs}` : ""}`);
}

export async function createAuditLog(entry: { action: string; panel?: string; details?: Record<string, unknown> }): Promise<{ ok: boolean; log?: AuditLog; error?: string }> {
  return apiFetch(APP_BASE, "/api/audit-logs", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

export async function getAuditStats(): Promise<{ ok: boolean; stats?: Record<string, unknown>; error?: string }> {
  return apiFetch(APP_BASE, "/api/audit-logs/stats");
}

// ─── App-worker: settings ───────────────────────────────────────────

export async function listSettings(): Promise<{ ok: boolean; settings?: Record<string, string>; error?: string }> {
  return apiFetch(APP_BASE, "/api/settings");
}

export async function getSetting(key: string): Promise<{ ok: boolean; value?: string; error?: string }> {
  return apiFetch(APP_BASE, `/api/settings/${encodeURIComponent(key)}`);
}

export async function upsertSettings(settings: Record<string, string>): Promise<{ ok: boolean; count?: number; error?: string }> {
  return apiFetch(APP_BASE, "/api/settings", {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });
}

export async function deleteSetting(key: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch(APP_BASE, `/api/settings/${encodeURIComponent(key)}`, { method: "DELETE" });
}

// ─── Autha-worker: tokens & entities ────────────────────────────────

export async function getEntityContext(entityId: string, systemUserId?: string): Promise<{ ok: boolean; entityId?: string; auth?: AuthContext["auth"]; captcha?: AuthContext["captcha"]; error?: string }> {
  const search = new URLSearchParams();
  if (systemUserId) search.set("systemUserId", systemUserId);
  const qs = search.toString();
  return apiFetch(AUTHA_BASE, `/api/entity/${entityId}/context${qs ? `?${qs}` : ""}`);
}

export async function listEntities(): Promise<AuthaEntitiesResponse> {
  return apiFetch(AUTHA_BASE, "/entities");
}

export async function getAuthaStats(): Promise<{ ok: boolean; stats?: Record<string, unknown>; error?: string }> {
  return apiFetch(AUTHA_BASE, "/stats");
}

// ─── Toque Worker: health & commands ────────────────────────────────

export async function getHealth(): Promise<{ ok: boolean }> {
  return apiFetch(API_BASE, "/health");
}

export async function runCommand(command: string, args?: Record<string, unknown>): Promise<ToqueResponse> {
  return apiFetch(API_BASE, `/cmd/${command}`, {
    method: args ? "POST" : "GET",
    body: args ? JSON.stringify(args) : undefined,
  });
}

export async function listCommands(): Promise<{ ok: boolean; commands?: string[]; error?: string }> {
  return apiFetch(API_BASE, "/cmd/list");
}

// ─── WebSocket: audit log stream ────────────────────────────────────

/**
 * Connect to the audit log WebSocket stream.
 * In production, this connects to the app-worker's /ws/audit endpoint
 * via the toque Worker's /app/ proxy.
 */
export function connectAuditStream(onMessage: (log: AuditLog) => void): WebSocket | null {
  if (typeof window === "undefined") return null;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // In dev, use the Next.js rewrite proxy. In production (served by the
  // toque-ui Worker), use the relative /api/app/ws/audit path which the
  // toque-ui Worker proxies to the toque Worker via service binding.
  const wsPath = IS_DEV ? "/api/proxy-app/ws/audit" : "/api/app/ws/audit";
  const wsUrl = `${protocol}//${window.location.host}${wsPath}`;
  try {
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "audit" || data.action) {
          onMessage(data);
        }
      } catch {
        // ignore non-JSON messages (e.g. "connected" welcome)
      }
    };
    return ws;
  } catch {
    return null;
  }
}
