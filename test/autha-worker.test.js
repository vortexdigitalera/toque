import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

/**
 * Tests for the autha-worker's upload verification and context building.
 * The Worker's `fetch` handler is exercised via a minimal fake env + Request.
 */

// Import the worker default export
const workerModule = await import("../packages/autha-worker/src/index.js");
const worker = workerModule.default;

// ─── Fake D1 ────────────────────────────────────────────────────────

function createFakeD1() {
  const rows = new Map();
  return {
    prepare(sql) {
      let bindings = [];
      const bound = (...args) => { bindings = args; return stmt; };
      const stmt = {
        bind: bound,
        async run() {
          // Naive INSERT OR REPLACE parser
          if (/INSERT OR REPLACE INTO records/i.test(sql)) {
            const [key, value, timestamp, systemUserId, profileTag, entityId, action] = bindings;
            rows.set(key, { key, value, timestamp, system_user_id: systemUserId, profile_tag: profileTag, entity_id: entityId, action });
            return { success: true };
          }
          return { success: true };
        },
        async all() {
          // Handle COUNT(*) GROUP BY queries (stats)
          if (/SELECT\s+(action|entity_id)/i.test(sql) && /GROUP BY/i.test(sql)) {
            const groups = new Map();
            const colMatch = sql.match(/SELECT\s+(\w+)/i);
            const groupCol = colMatch ? colMatch[1] : "action";
            for (const row of rows.values()) {
              if (groupCol === "action") {
                const k = row.action || "UNKNOWN";
                groups.set(k, (groups.get(k) || 0) + 1);
              } else if (groupCol === "entity_id") {
                if (!row.entity_id) continue;
                const k = row.entity_id;
                groups.set(k, (groups.get(k) || 0) + 1);
              }
            }
            const results = [...groups.entries()].map(([k, count]) =>
              groupCol === "action" ? { action: k, count } : { entityId: k, count });
            results.sort((a, b) => b.count - a.count);
            return { results };
          }
          // Handle SELECT DISTINCT entity_id (entities list)
          if (/SELECT DISTINCT entity_id/i.test(sql)) {
            const seen = new Set();
            const entities = [];
            for (const row of rows.values()) {
              if (row.entity_id && !seen.has(row.entity_id)) {
                seen.add(row.entity_id);
                entities.push({ entityId: row.entity_id });
              }
            }
            entities.sort((a, b) => a.entityId.localeCompare(b.entityId));
            return { results: entities };
          }
          // Handle SELECT MAX(timestamp) (stats)
          if (/SELECT MAX\(timestamp\)/i.test(sql)) {
            let max = 0;
            for (const row of rows.values()) {
              if (row.timestamp > max) max = row.timestamp;
            }
            return { results: [{ latest: max }] };
          }
          // Handle SELECT COUNT(*) (stats total)
          if (/SELECT COUNT\(\*\)/i.test(sql) && !/GROUP BY/i.test(sql)) {
            return { results: [{ count: rows.size }] };
          }
          // Handle SELECT key, value, timestamp FROM records WHERE ...
          if (/SELECT key, value, timestamp FROM records/i.test(sql)) {
            const results = [];
            for (const row of rows.values()) {
              // entity_id = ? OR key LIKE ?
              if (sql.includes("entity_id = ? OR key LIKE ?")) {
                const eid = bindings[0];
                const pattern = bindings[1].replace(/%/g, ".*");
                if (row.entity_id !== eid && !new RegExp(`^${pattern}$`).test(row.key)) continue;
              } else if (sql.includes("key LIKE ?")) {
                const pattern = bindings[0].replace(/%/g, ".*");
                if (!new RegExp(`^${pattern}$`).test(row.key)) continue;
              }
              // system_user_id = ? OR system_user_id = 'default'
              if (sql.includes("system_user_id = ? OR system_user_id = 'default'")) {
                const uid = bindings[2];
                if (row.system_user_id !== uid && row.system_user_id !== "default") continue;
              } else if (sql.includes("system_user_id = ?")) {
                const uid = bindings[0];
                if (row.system_user_id !== uid) continue;
              }
              // action LIKE '%AUTH_TOKEN%' OR action LIKE '%SYNC%'
              if (sql.includes("action LIKE '%AUTH_TOKEN%' OR action LIKE '%SYNC%'")) {
                const a = String(row.action || "");
                if (!a.includes("AUTH_TOKEN") && !a.includes("SYNC")) continue;
              }
              results.push({ key: row.key, value: row.value, timestamp: row.timestamp });
            }
            results.sort((a, b) => b.timestamp - a.timestamp);
            const limitMatch = sql.match(/LIMIT (\d+)/);
            if (limitMatch) results.length = Math.min(results.length, Number(limitMatch[1]));
            return { results };
          }
          return { results: [] };
        },
        async first() {
          const res = await stmt.all();
          return res.results[0] || null;
        },
      };
      return stmt;
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function signBody(body, timestamp, secret) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

function makeUploadRequest(record, { apiToken, signingSecret, headers = {} } = {}) {
  const body = JSON.stringify(record);
  const timestamp = String(record.timestamp || Date.now());
  const signature = signBody(body, timestamp, signingSecret);
  return new Request("https://autha-worker.test/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`,
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

async function fetchWorker(request, env) {
  return worker.fetch(request, env);
}

// ─── Tests ──────────────────────────────────────────────────────────

const API_TOKEN = "test-api-token";
const SIGNING_SECRET = "test-signing-secret";

test("health endpoint is public and reports d1 storage", async () => {
  const env = { AUTHA_DB: createFakeD1(), AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  const res = await fetchWorker(new Request("https://autha-worker.test/health"), env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.service, "autha-worker");
  assert.equal(json.storage, "d1");
});

test("health works without auth token", async () => {
  const env = { AUTHA_DB: createFakeD1(), AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  const res = await fetchWorker(new Request("https://autha-worker.test/health"), env);
  assert.equal(res.status, 200);
});

test("rejects unauthenticated requests to non-health endpoints", async () => {
  const env = { AUTHA_DB: createFakeD1(), AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  const res = await fetchWorker(new Request("https://autha-worker.test/entities"), env);
  assert.equal(res.status, 401);
});

test("accepts a signed upload and stores it in D1", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  const record = {
    action: "NUSUK_AUTHA_AUTH_TOKEN",
    source: "test",
    timestamp: Date.now(),
    entityId: "525513",
    token: "Bearer eyJhbGc.test.token",
    tokenType: 3,
  };
  const res = await fetchWorker(makeUploadRequest(record, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);
  const json = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(json)}`);
  assert.equal(json.ok, true);
  assert.equal(json.entityId, "525513");
  assert.ok(json.key.startsWith("entity_525513_NUSUK_AUTHA_AUTH_TOKEN_"));
});

test("rejects upload with invalid signature", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  const record = {
    action: "NUSUK_AUTHA_AUTH_TOKEN",
    timestamp: Date.now(),
    entityId: "525513",
    token: "Bearer fake",
  };
  const body = JSON.stringify(record);
  const timestamp = String(record.timestamp);
  const badSig = createHmac("sha256", "wrong-secret").update(`${timestamp}.${body}`).digest("hex");
  const req = new Request("https://autha-worker.test/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_TOKEN}`,
      "X-Autha-Timestamp": timestamp,
      "X-Autha-Signature": badSig,
    },
    body,
  });
  const res = await fetchWorker(req, env);
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.match(json.error, /signature/i);
});

test("rejects upload with stale timestamp (replay protection)", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  const staleTimestamp = String(Date.now() - 600_000); // 10 min ago
  const record = { action: "NUSUK_AUTHA_AUTH_TOKEN", timestamp: Number(staleTimestamp), entityId: "1", token: "x" };
  const body = JSON.stringify(record);
  const sig = signBody(body, staleTimestamp, SIGNING_SECRET);
  const req = new Request("https://autha-worker.test/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_TOKEN}`,
      "X-Autha-Timestamp": staleTimestamp,
      "X-Autha-Signature": sig,
    },
    body,
  });
  const res = await fetchWorker(req, env);
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.match(json.error, /timestamp/i);
});

test("entity context endpoint returns latest auth token", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  // Upload an auth token
  const record = {
    action: "NUSUK_AUTHA_AUTH_TOKEN",
    source: "test",
    timestamp: Date.now(),
    entityId: "525513",
    activeEntityId: "525513",
    entityTypeId: "1",
    activeEntityTypeId: "1",
    token: "Bearer eyJhbGc.test.token",
    tokenType: 3,
  };
  await fetchWorker(makeUploadRequest(record, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);

  // Query context
  const req = new Request("https://autha-worker.test/api/entity/525513/context?systemUserId=default", {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  const res = await fetchWorker(req, env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.entityId, "525513");
  assert.ok(json.auth, "auth should be present");
  assert.equal(json.auth.token, "Bearer eyJhbGc.test.token");
  assert.equal(json.auth.tokenType, 3);
});

test("entity context endpoint returns captcha tokens by type", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  // Upload a visa captcha
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_CAPTCHA",
    source: "test",
    timestamp: Date.now(),
    entityId: "525513",
    captchaType: "visa",
    token: "captcha-visa-token",
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);

  // Upload a login captcha
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_CAPTCHA",
    source: "test",
    timestamp: Date.now(),
    entityId: "525513",
    captchaType: "login",
    token: "captcha-login-token",
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);

  const req = new Request("https://autha-worker.test/api/entity/525513/context", {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  const res = await fetchWorker(req, env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.captcha.visa, "visa captcha should be present");
  assert.equal(json.captcha.visa.captchaToken, "captcha-visa-token");
  assert.ok(json.captcha.login, "login captcha should be present");
  assert.equal(json.captcha.login.captchaToken, "captcha-login-token");
});

test("latest token endpoint returns the most recent auth token", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  // Upload two tokens, second is newer
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_AUTH_TOKEN",
    timestamp: Date.now() - 5000,
    entityId: "525513",
    token: "Bearer old-token",
    tokenType: 3,
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_AUTH_TOKEN",
    timestamp: Date.now(),
    entityId: "525513",
    token: "Bearer new-token",
    tokenType: 3,
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);

  const req = new Request("https://autha-worker.test/entity/525513/token/latest", {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  const res = await fetchWorker(req, env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.latestAuthToken, "latestAuthToken should be present");
  assert.equal(json.latestAuthToken.token, "Bearer new-token");
});

test("entities list returns distinct entity IDs", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_AUTH_TOKEN", timestamp: Date.now(), entityId: "111", token: "a",
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_AUTH_TOKEN", timestamp: Date.now(), entityId: "222", token: "b",
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_AUTH_TOKEN", timestamp: Date.now(), entityId: "111", token: "c",
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);

  const req = new Request("https://autha-worker.test/entities", {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  const res = await fetchWorker(req, env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.count, 2);
  assert.ok(json.entities.includes("111"));
  assert.ok(json.entities.includes("222"));
});

test("stats endpoint returns record counts", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_AUTH_TOKEN", timestamp: Date.now(), entityId: "111", token: "a",
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_CAPTCHA", timestamp: Date.now(), entityId: "111", token: "b",
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);

  const req = new Request("https://autha-worker.test/stats", {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  const res = await fetchWorker(req, env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.stats.totalRecords, 2);
  assert.ok(json.stats.latestRecord > 0);
});

test("records list endpoint filters by prefix", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_AUTH_TOKEN", timestamp: Date.now(), entityId: "111", token: "a",
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);

  const req = new Request("https://autha-worker.test/records?prefix=entity_111_&limit=10", {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  const res = await fetchWorker(req, env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.count, 1);
  assert.match(json.records[0].key, /^entity_111_/);
});

test("single record endpoint returns the full record", async () => {
  const d1 = createFakeD1();
  const env = { AUTHA_DB: d1, AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  const uploadRes = await fetchWorker(makeUploadRequest({
    action: "NUSUK_AUTHA_AUTH_TOKEN", timestamp: Date.now(), entityId: "111", token: "a", tokenType: 3,
  }, { apiToken: API_TOKEN, signingSecret: SIGNING_SECRET }), env);
  const uploadJson = await uploadRes.json();
  const key = uploadJson.key;

  const req = new Request(`https://autha-worker.test/records/${encodeURIComponent(key)}`, {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  const res = await fetchWorker(req, env);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.record.token, "a");
  assert.equal(json.record.tokenType, 3);
});

test("returns 404 for unknown routes", async () => {
  const env = { AUTHA_DB: createFakeD1(), AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  const res = await fetchWorker(new Request("https://autha-worker.test/unknown", {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  }), env);
  assert.equal(res.status, 404);
});

test("returns 500 when D1 binding is missing", async () => {
  const env = { AUTHA_API_TOKEN: API_TOKEN, AUTHA_SIGNING_SECRET: SIGNING_SECRET };
  const res = await fetchWorker(new Request("https://autha-worker.test/entities", {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  }), env);
  assert.equal(res.status, 500);
});
