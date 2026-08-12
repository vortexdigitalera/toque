/**
 * Autha Worker — Cloudflare Workers D1 REST JSON API
 *
 * Stores auth/captcha tokens and entity context uploaded by the Nusuk
 * browser extension, and serves them to the toque container, MCP server,
 * and dashboard via a simple REST API.
 *
 * Storage: D1 (binding AUTHA_DB). Replaces the earlier KV-based version.
 *
 * Endpoints:
 *   GET    /health                       — Health check (public)
 *   POST   /upload                        — Store a signed/unsigned record
 *   GET    /records                       — List records (?prefix=&limit=)
 *   GET    /records/:key                  — Get a single record by key
 *   DELETE /records                       — Delete ALL records (wipe)
 *   DELETE /records/:key                  — Delete a single record
 *   GET    /entities                      — List distinct entity IDs
 *   GET    /entity/:entityId              — Query records for an entity
 *   GET    /entity/:entityId/latest       — Latest record for an entity
 *   GET    /entity/:entityId/token/latest — Latest auth token for an entity
 *   GET    /entity/:entityId/captchas     — List captcha records for an entity
 *   GET    /api/entity/:entityId/context  — Full entity context (auth + captcha)
 *   GET    /api/user/:systemUserId/context — Full user context across entities
 *   GET    /stats                         — System metadata & statistics
 *
 * Auth:
 *   - Bearer token (AUTHA_API_TOKEN) — for CLI/container/MCP clients
 *   - /health is always public
 *
 * Signed uploads:
 *   - X-Autha-Timestamp + X-Autha-Signature (HMAC-SHA256 over `${ts}.${body}`)
 *   - Verified against AUTHA_SIGNING_SECRET when both headers are present
 *   - Replay protection: timestamp must be within 5 minutes
 */

// ─── Helpers ────────────────────────────────────────────────────────

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Autha-*",
      ...(init.headers || {}),
    },
  });
}

function errorResponse(status, message) {
  return jsonResponse({ ok: false, error: message }, { status });
}

function sanitizeSystemUserId(value) {
  const v = String(value || "").trim();
  if (!v) return "default";
  return v.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Extract entity ID from the record body or request headers. */
function extractEntityId(record, request) {
  if (record.entityId) return String(record.entityId);
  if (record.activeEntityId) return String(record.activeEntityId);
  const fromHeader =
    request.headers.get("entity-id") ||
    request.headers.get("activeentityid") ||
    request.headers.get("x-autha-entity-id") ||
    "";
  return fromHeader.trim();
}

/** Detect whether a record is a captcha record. */
function isCaptchaRecord(record) {
  const action = String(record.action || "").toUpperCase();
  if (action.includes("CAPTCHA")) return true;
  if (record.captchaType) return true;
  if (record.captchaToken) return true;
  return false;
}

/** Extract the captcha token from a record. */
function extractCaptchaToken(record) {
  return record.captchaToken || record.token || record.captcha || "";
}

/** Classify a captcha record as LOGIN or SEND_ISSUE_VISA. */
function classifyCaptchaType(record, token) {
  const action = String(record.action || "").toUpperCase();
  const type = String(record.captchaType || "").toLowerCase();
  const t = String(token || "").toLowerCase();

  if (type === "login" || action.includes("LOGIN")) return "LOGIN";
  if (
    type === "visa" ||
    type === "send_issue_visa" ||
    action.includes("VISA") ||
    action.includes("SEND_ISSUE") ||
    action.includes("SENDCAPTCHA")
  ) {
    return "SEND_ISSUE_VISA";
  }
  // Default captcha records (no login/visa signal) are treated as general.
  return "GENERAL";
}

/** Generate a stable key for a record. */
function generateKey(record, entityId) {
  const action = record.action || "UNKNOWN";
  const ts = record.timestamp || Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `entity_${entityId}_${action}_${ts}_${rand}`;
}

/** Sanitize a record before storage — strip bloated fields. */
function sanitizeRecord(record) {
  const MAX_VALUE = 64 * 1024; // 64 KB per stored value
  const clean = { ...record };

  // Strip known-bloated fields
  const bloatedKeys = ["html", "dom", "document", "page", "body", "responseText", "responseHTML"];
  for (const k of bloatedKeys) {
    if (k in clean && typeof clean[k] === "string" && clean[k].length > 4096) {
      clean[k] = `${clean[k].slice(0, 256)}...[truncated ${clean[k].length} chars]`;
    }
  }

  // Truncate any oversized string field
  for (const k of Object.keys(clean)) {
    if (typeof clean[k] === "string" && clean[k].length > MAX_VALUE) {
      clean[k] = `${clean[k].slice(0, 1024)}...[truncated ${clean[k].length} chars]`;
    }
  }

  return clean;
}

// ─── Auth ────────────────────────────────────────────────────────────

async function verifySignature(body, timestamp, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`)
  );
  const expectedHex = [...new Uint8Array(expected)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time-ish comparison
  if (expectedHex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/** Authenticate a request. Returns true if authorized. */
function authenticate(request, env) {
  if (env.AUTHA_API_TOKEN) {
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token && token === env.AUTHA_API_TOKEN) return true;
  }
  // No token configured → allow (open mode, e.g. tests without token)
  if (!env.AUTHA_API_TOKEN) return true;
  return false;
}

// ─── D1 Helpers ──────────────────────────────────────────────────────

const RECORDS_TABLE = "records";

/** Insert a record into D1. */
async function storeRecord(db, { key, value, timestamp, systemUserId, profileTag, entityId, action }) {
  await db
    .prepare(
      "INSERT OR REPLACE INTO records (key, value, timestamp, system_user_id, profile_tag, entity_id, action) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      key,
      value,
      timestamp,
      systemUserId,
      profileTag,
      entityId,
      action
    )
    .run();
}

/** Parse a stored record value (JSON) from a D1 row. */
function parseRecordValue(row) {
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value || "{}");
    return { ...parsed, key: row.key, timestamp: row.timestamp };
  } catch {
    return { key: row.key, timestamp: row.timestamp, raw: row.value };
  }
}

// ─── Request Handlers ────────────────────────────────────────────────

async function handleHealth(request, env) {
  return jsonResponse({
    ok: true,
    service: "autha-worker",
    storage: "d1",
    timestamp: Date.now(),
  });
}

async function handleUpload(request, env) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");

  const rawBody = await request.text();
  if (!rawBody) return errorResponse(400, "Empty body");

  // Signature verification (if both headers present)
  const timestamp = request.headers.get("X-Autha-Timestamp") || "";
  const signature = request.headers.get("X-Autha-Signature") || "";
  const signingSecret = env.AUTHA_SIGNING_SECRET || "autha-default-secret";

  if (timestamp && signature) {
    const age = Math.abs(Date.now() - Number(timestamp));
    if (age > 5 * 60 * 1000) {
      return errorResponse(401, "Timestamp too old (replay protection)");
    }
    const valid = await verifySignature(rawBody, timestamp, signature, signingSecret);
    if (!valid) return errorResponse(401, "Invalid signature");
  }

  let record;
  try {
    record = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, "Invalid JSON");
  }

  const entityId = extractEntityId(record, request);
  if (!entityId) return errorResponse(400, "Missing entityId");

  const systemUserId = sanitizeSystemUserId(
    request.headers.get("X-Autha-System-User-Id") || record.systemUserId
  );
  const action = record.action || "UNKNOWN";
  const source = record.source || "UNKNOWN";
  const profileTag = record.profileTag || "default";
  const ts = record.timestamp || Date.now();

  const cleanRecord = sanitizeRecord(record);
  const key = generateKey(cleanRecord, entityId);
  const value = JSON.stringify(cleanRecord, null, 2);

  await storeRecord(dbOrError(env), {
    key,
    value,
    timestamp: ts,
    systemUserId,
    profileTag,
    entityId,
    action,
  });

  return jsonResponse({
    ok: true,
    key,
    entityId,
    action,
    source,
    timestamp: ts,
  });
}

async function handleRecordsList(request, env, url) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const prefix = url.searchParams.get("prefix") || "";
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);

  let results;
  if (prefix) {
    const pattern = `${prefix}%`;
    results = await env.AUTHA_DB
      .prepare(
        "SELECT key, value, timestamp FROM records WHERE key LIKE ? ORDER BY timestamp DESC LIMIT ?"
      )
      .bind(pattern, limit)
      .all();
  } else {
    results = await env.AUTHA_DB
      .prepare(
        "SELECT key, value, timestamp FROM records ORDER BY timestamp DESC LIMIT ?"
      )
      .bind(limit)
      .all();
  }

  const records = (results.results || []).map((row) => ({
    key: row.key,
    timestamp: row.timestamp,
    ...(safeParse(row.value)),
  }));

  return jsonResponse({ ok: true, count: records.length, records });
}

async function handleRecordGet(request, env, key) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const row = await env.AUTHA_DB
    .prepare("SELECT key, value, timestamp FROM records WHERE key = ?")
    .bind(key)
    .first();
  if (!row) return errorResponse(404, "Record not found");
  return jsonResponse({ ok: true, record: { key: row.key, timestamp: row.timestamp, ...safeParse(row.value) } });
}

async function handleRecordsWipe(request, env) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  await env.AUTHA_DB.prepare("DELETE FROM records").run();
  return jsonResponse({ ok: true, wiped: true });
}

async function handleRecordDelete(request, env, key) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  await env.AUTHA_DB.prepare("DELETE FROM records WHERE key = ?").bind(key).run();
  return jsonResponse({ ok: true, deleted: true, key });
}

async function handleEntitiesList(request, env) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const results = await env.AUTHA_DB
    .prepare("SELECT DISTINCT entity_id FROM records WHERE entity_id IS NOT NULL ORDER BY entity_id")
    .all();
  const entities = (results.results || []).map((r) => r.entityId || r.entity_id).filter(Boolean);
  return jsonResponse({ ok: true, count: entities.length, entities });
}

async function handleEntityQuery(request, env, entityId, url) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const type = url.searchParams.get("type") || "";
  const systemUserId = url.searchParams.get("systemUserId") || "";
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);

  let sql = "SELECT key, value, timestamp FROM records WHERE entity_id = ?";
  const binds = [entityId];
  if (systemUserId) {
    sql += " AND (system_user_id = ? OR system_user_id = 'default')";
    binds.push(sanitizeSystemUserId(systemUserId));
  }
  if (type) {
    sql += " AND action LIKE ?";
    binds.push(`%${type.toUpperCase()}%`);
  }
  sql += " ORDER BY timestamp DESC LIMIT ?";
  binds.push(limit);

  const results = await env.AUTHA_DB.prepare(sql).bind(...binds).all();
  const records = (results.results || []).map((row) => ({
    key: row.key,
    timestamp: row.timestamp,
    ...safeParse(row.value),
  }));
  return jsonResponse({ ok: true, entityId, count: records.length, records });
}

async function handleEntityLatest(request, env, entityId) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const row = await env.AUTHA_DB
    .prepare(
      "SELECT key, value, timestamp FROM records WHERE entity_id = ? ORDER BY timestamp DESC LIMIT 1"
    )
    .bind(entityId)
    .first();
  if (!row) return errorResponse(404, "No records for entity");
  return jsonResponse({ ok: true, entityId, latest: { key: row.key, timestamp: row.timestamp, ...safeParse(row.value) } });
}

async function handleLatestToken(request, env, entityId) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const row = await env.AUTHA_DB
    .prepare(
      "SELECT key, value, timestamp FROM records WHERE entity_id = ? AND (action LIKE '%AUTH_TOKEN%' OR action LIKE '%SYNC%') ORDER BY timestamp DESC LIMIT 1"
    )
    .bind(entityId)
    .first();
  if (!row) return errorResponse(404, "No auth token for entity");
  const parsed = safeParse(row.value);
  return jsonResponse({
    ok: true,
    entityId,
    latestAuthToken: {
      key: row.key,
      timestamp: row.timestamp,
      token: parsed.token || null,
      tokenType: parsed.tokenType ?? null,
    },
  });
}

async function handleEntityCaptchas(request, env, entityId) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const results = await env.AUTHA_DB
    .prepare(
      "SELECT key, value, timestamp FROM records WHERE entity_id = ? AND action LIKE '%CAPTCHA%' ORDER BY timestamp DESC LIMIT 100"
    )
    .bind(entityId)
    .all();
  const captchas = (results.results || []).map((row) => ({
    key: row.key,
    timestamp: row.timestamp,
    ...safeParse(row.value),
  }));
  return jsonResponse({ ok: true, entityId, count: captchas.length, captchas });
}

async function handleEntityContext(request, env, entityId, url) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const systemUserId = url.searchParams.get("systemUserId") || "default";
  const uid = sanitizeSystemUserId(systemUserId);

  // Latest auth token
  const authRow = await env.AUTHA_DB
    .prepare(
      "SELECT key, value, timestamp FROM records WHERE entity_id = ? AND (action LIKE '%AUTH_TOKEN%' OR action LIKE '%SYNC%') AND (system_user_id = ? OR system_user_id = 'default') ORDER BY timestamp DESC LIMIT 1"
    )
    .bind(entityId, uid)
    .first();

  // Latest captcha records (login + visa)
  const captchaRows = await env.AUTHA_DB
    .prepare(
      "SELECT key, value, timestamp FROM records WHERE entity_id = ? AND action LIKE '%CAPTCHA%' AND (system_user_id = ? OR system_user_id = 'default') ORDER BY timestamp DESC LIMIT 50"
    )
    .bind(entityId, uid)
    .all();

  const captcha = { visa: null, login: null, general: null };
  for (const row of captchaRows.results || []) {
    const parsed = safeParse(row.value);
    const token = parsed.captchaToken || parsed.token || "";
    const type = (parsed.captchaType || classifyCaptchaType(parsed, token)).toLowerCase();
    const entry = {
      key: row.key,
      timestamp: row.timestamp,
      captchaToken: token,
      captchaType: parsed.captchaType || null,
      action: parsed.action || null,
    };
    if (type === "login" && !captcha.login) captcha.login = entry;
    else if ((type === "visa" || type === "send_issue_visa") && !captcha.visa) captcha.visa = entry;
    else if (!captcha.general) captcha.general = entry;
  }

  const auth = authRow
    ? {
        key: authRow.key,
        timestamp: authRow.timestamp,
        token: safeParse(authRow.value).token || null,
        tokenType: safeParse(authRow.value).tokenType ?? null,
      }
    : null;

  return jsonResponse({ ok: true, entityId, auth, captcha });
}

async function handleUserContext(request, env, systemUserId) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const uid = sanitizeSystemUserId(systemUserId);
  const results = await env.AUTHA_DB
    .prepare(
      "SELECT key, value, timestamp, entity_id FROM records WHERE system_user_id = ? OR system_user_id = 'default' ORDER BY timestamp DESC LIMIT 200"
    )
    .bind(uid)
    .all();

  // Group by entity
  const byEntity = new Map();
  for (const row of results.results || []) {
    const eid = row.entityId || row.entity_id;
    if (!eid) continue;
    if (!byEntity.has(eid)) byEntity.set(eid, []);
    byEntity.get(eid).push({ key: row.key, timestamp: row.timestamp, ...safeParse(row.value) });
  }

  const entities = [...byEntity.entries()].map(([entityId, records]) => ({
    entityId,
    count: records.length,
    latest: records[0] || null,
  }));

  return jsonResponse({ ok: true, systemUserId: uid, count: entities.length, entities });
}

async function handleStats(request, env) {
  if (!env.AUTHA_DB) return errorResponse(500, "AUTHA_DB binding not configured");
  const total = await env.AUTHA_DB.prepare("SELECT COUNT(*) as count FROM records").first();
  const latest = await env.AUTHA_DB.prepare("SELECT MAX(timestamp) as latest FROM records").first();
  const byAction = await env.AUTHA_DB
    .prepare("SELECT action, COUNT(*) as count FROM records GROUP BY action ORDER BY count DESC")
    .all();
  const byEntity = await env.AUTHA_DB
    .prepare("SELECT entity_id, COUNT(*) as count FROM records GROUP BY entity_id ORDER BY count DESC")
    .all();

  return jsonResponse({
    ok: true,
    stats: {
      totalRecords: total?.count || 0,
      latestRecord: latest?.latest || 0,
      byAction: (byAction.results || []).map((r) => ({ action: r.action, count: r.count })),
      byEntity: (byEntity.results || []).map((r) => ({ entityId: r.entityId || r.entity_id, count: r.count })),
    },
  });
}

function safeParse(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function dbOrError(env) {
  if (!env.AUTHA_DB) throw new Error("AUTHA_DB binding not configured");
  return env.AUTHA_DB;
}

// ─── Router ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Autha-*",
        },
      });
    }

    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    // Health is always public
    if (parts.length === 1 && parts[0] === "health") {
      return handleHealth(request, env);
    }

    // Auth gate for everything else
    if (!authenticate(request, env)) {
      return errorResponse(401, "Unauthorized");
    }

    try {
      // POST /upload
      if (method === "POST" && parts.length === 1 && parts[0] === "upload") {
        return await handleUpload(request, env);
      }
      // POST / (legacy root upload)
      if (method === "POST" && parts.length === 0) {
        return await handleUpload(request, env);
      }

      // GET /records
      if (method === "GET" && parts.length === 1 && parts[0] === "records") {
        return await handleRecordsList(request, env, url);
      }
      // GET /records/:key
      if (method === "GET" && parts.length === 2 && parts[0] === "records") {
        return await handleRecordGet(request, env, decodeURIComponent(parts[1]));
      }
      // DELETE /records
      if (method === "DELETE" && parts.length === 1 && parts[0] === "records") {
        return await handleRecordsWipe(request, env);
      }
      // DELETE /records/:key
      if (method === "DELETE" && parts.length === 2 && parts[0] === "records") {
        return await handleRecordDelete(request, env, decodeURIComponent(parts[1]));
      }

      // GET /entities
      if (method === "GET" && parts.length === 1 && parts[0] === "entities") {
        return await handleEntitiesList(request, env);
      }

      // GET /stats
      if (method === "GET" && parts.length === 1 && parts[0] === "stats") {
        return await handleStats(request, env);
      }

      // GET /entity/:entityId
      if (method === "GET" && parts.length === 2 && parts[0] === "entity") {
        return await handleEntityQuery(request, env, decodeURIComponent(parts[1]), url);
      }
      // GET /entity/:entityId/latest
      if (method === "GET" && parts.length === 3 && parts[0] === "entity" && parts[2] === "latest") {
        return await handleEntityLatest(request, env, decodeURIComponent(parts[1]));
      }
      // GET /entity/:entityId/token/latest
      if (method === "GET" && parts.length === 4 && parts[0] === "entity" && parts[2] === "token" && parts[3] === "latest") {
        return await handleLatestToken(request, env, decodeURIComponent(parts[1]));
      }
      // GET /entity/:entityId/captchas
      if (method === "GET" && parts.length === 3 && parts[0] === "entity" && parts[2] === "captchas") {
        return await handleEntityCaptchas(request, env, decodeURIComponent(parts[1]));
      }

      // GET /api/entity/:entityId/context
      if (method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "entity" && parts[3] === "context") {
        return await handleEntityContext(request, env, decodeURIComponent(parts[2]), url);
      }
      // GET /api/user/:systemUserId/context
      if (method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "user" && parts[3] === "context") {
        return await handleUserContext(request, env, decodeURIComponent(parts[2]));
      }

      return errorResponse(404, "Not found");
    } catch (err) {
      return errorResponse(500, err?.message || "Internal error");
    }
  },
};
