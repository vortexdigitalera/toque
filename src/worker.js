/**
 * AuthaWorker — client for the D1-backed autha-worker REST API.
 *
 * Pulls the latest captured auth token and captcha token that the browser
 * extension saved to the worker, so toque can use them for actions without
 * manually copying files.
 *
 * Usage:
 *   const worker = new AuthaWorker({ entityId: "525513" });
 *   const token   = await worker.fetchLatestAuthToken();
 *   const captcha = await worker.fetchLatestCaptcha(undefined, "visa");
 */

import { readFileSync } from "fs";
import { parseJwt } from "./jwt.js";

const DEFAULT_ENDPOINT = "https://autha-worker.decloud.workers.dev";
const CAPTCHA_TYPES = new Set(["visa", "login", "general"]);

export class AuthaWorker {
  constructor(config = {}) {
    // When AUTHA_PROXY_URL is set (by the toque Worker's container envVars),
    // route requests through the Worker's /autha/* service-binding proxy
    // instead of calling the autha-worker directly over the public internet.
    // The proxy injects the API token via the service binding, so the
    // apiToken is not needed in proxy mode.
    const proxyUrl = config.proxyUrl || process.env.AUTHA_PROXY_URL || "";
    this.proxyMode = Boolean(proxyUrl);
    this.endpoint = (
      config.endpoint ||
      (this.proxyMode ? proxyUrl : process.env.WORKER_URL) ||
      DEFAULT_ENDPOINT
    ).replace(/\/+$/, "");
    this.entityId =
      config.entityId || process.env.ACTIVE_ENTITY_ID || this._readEntityFile()?.activeEntityId || null;
    this.systemUserId =
      config.systemUserId ||
      process.env.SYSTEM_USER_ID ||
      this._readEntityFile()?.systemUserId ||
      "default";
    this.apiToken = config.apiToken || process.env.WORKER_API_TOKEN || "";
    this._contextCache = new Map();
    // Direct D1 mode: when a D1 binding is available (e.g. in the Worker
    // runtime), query the database directly instead of making an HTTP
    // request to the autha-worker. This eliminates the service-binding
    // round-trip for token pulls, reducing latency by ~10-20ms.
    // Set via `new AuthaWorker({ d1: env.AUTHA_DB })` in the Worker.
    this.d1 = config.d1 || null;
  }

  _readEntityFile() {
    const filePath = process.env.ENTITY_CONFIG_PATH || "entity.json";
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  async _get(path) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.endpoint}${path}${sep}systemUserId=${encodeURIComponent(this.systemUserId)}`;
    // In proxy mode, the toque Worker injects the API token via the
    // service binding — no Authorization header needed from the client.
    if (!this.proxyMode && !this.apiToken) {
      throw new Error("WORKER_API_TOKEN is required");
    }
    const headers = { Accept: "application/json" };
    if (!this.proxyMode) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }
    const resp = await fetch(url, { headers });
    let json = null;
    try {
      json = await resp.json();
    } catch {
      json = null;
    }
    if (!resp.ok || !json?.ok) {
      throw new Error(
        `Worker GET ${path} failed (${resp.status}): ${json?.error || resp.statusText}`
      );
    }
    return json;
  }

  /**
   * Query D1 directly for an entity's latest auth + captcha records.
   * Only used when a D1 binding is available (Worker runtime).
   * Bypasses the HTTP round-trip to the autha-worker entirely.
   * @param {string} entityId
   * @returns {Promise<object>} context object
   */
  async _getD1Context(entityId) {
    const result = await this.d1
      .prepare(
        `SELECT key, value, timestamp FROM records
         WHERE key LIKE ? || '_%'
         ORDER BY timestamp DESC
         LIMIT 50`,
      )
      .bind(`entity_${entityId}_`)
      .all();

    const records = result.results || [];
    const context = {
      ok: true,
      entityId,
      auth: null,
      captcha: {},
      entity: {},
    };

    for (const r of records) {
      let parsed;
      try {
        parsed = JSON.parse(r.value);
      } catch {
        continue;
      }
      const action = String(parsed.action || parsed.metadata?.action || "").toUpperCase();

      if (action.includes("AUTH_TOKEN") || action.includes("SYNC")) {
        if (!context.auth || r.timestamp > (context.auth.timestamp || 0)) {
          context.auth = {
            token: parsed.token || parsed.userToken || parsed.value,
            timestamp: r.timestamp,
            tokenType: parsed.tokenType,
          };
          context.entityId = parsed.entityId || parsed.activeEntityId || context.entityId;
          context.entity = {
            entityId: context.entityId,
            activeEntityId: parsed.activeEntityId || context.entityId,
            entityTypeId: parsed.entityTypeId,
            activeEntityTypeId: parsed.activeEntityTypeId,
          };
        }
      }

      if (action.includes("CAPTCHA")) {
        const type = parsed.captchaType || "visa";
        if (!context.captcha[type] || r.timestamp > (context.captcha.timestamp || 0)) {
          context.captcha[type] = { captchaToken: parsed.token || parsed.value };
          context.captcha.timestamp = r.timestamp;
        }
      }
    }

    return context;
  }

  async fetchContext(entityId, { refresh = false } = {}) {
    const eid = entityId || this.entityId;
    if (!eid) throw new Error("Entity ID required (pass entityId or --entity)");
    const cacheKey = String(eid);
    if (!refresh && this._contextCache.has(cacheKey)) {
      return this._contextCache.get(cacheKey);
    }
    // Direct D1 mode: skip HTTP entirely when a D1 binding is available
    let context;
    if (this.d1) {
      context = await this._getD1Context(cacheKey);
    } else {
      context = await this._get(`/api/entity/${encodeURIComponent(cacheKey)}/context`);
    }
    this._contextCache.set(cacheKey, context);
    return context;
  }

  async fetchUserContext(systemUserId) {
    const uid = String(systemUserId || this.systemUserId || "").trim();
    if (!uid) throw new Error("System user ID is required");
    return this._get(`/api/user/${encodeURIComponent(uid)}/context`);
  }

  /**
   * Pull the latest auth token (Bearer) captured for an entity.
   * Returns { token, entityId, timestamp } so the token can be used with
   * its own entity. Searches the newest AUTH_TOKEN / SYNC records.
   */
  async fetchLatestAuthToken(entityId) {
    const eid = entityId || this.entityId;
    if (!eid) throw new Error("Entity ID required (pass entityId or --entity)");

    try {
      const context = await this.fetchContext(eid);
      const token = this.extractToken(context.auth);
      if (token) {
        return {
          token,
          entityId: String(context.entityId || context.entity?.entityId || eid),
          timestamp: Number(context.auth?.timestamp || 0),
        };
      }
    } catch {
      // Fall back to the legacy endpoint during staged Worker upgrades.
    }

    try {
      const json = await this._get(`/entity/${encodeURIComponent(eid)}/token/latest`);
      const record = json.latestAuthToken;
      const token = this.extractToken(record);
      if (token) {
        return {
          token,
          entityId: String(record?.entityId || json.entityId || eid),
          timestamp: Number(record?.timestamp || json.metadata?.timestamp || 0),
        };
      }
    } catch {
      // Fall back to the record scan below.
    }

    let list;
    try {
      list = await this._get(
        `/records?prefix=${encodeURIComponent(`entity_${eid}_`)}&limit=200`
      );
    } catch {
      return null;
    }

    const candidates = (list.records || [])
      .filter((r) => {
        const action = String(r.metadata?.action || "").toUpperCase();
        return action.includes("AUTH_TOKEN") || action.includes("SYNC");
      })
      .sort((a, b) => (b.metadata?.timestamp || 0) - (a.metadata?.timestamp || 0))
      .slice(0, 10);

    for (const r of candidates) {
      try {
        const rec = await this._get(`/records/${encodeURIComponent(r.key)}`);
        const token = this.extractToken(rec.record);
        if (!token) continue;
        return {
          token,
          entityId: String(
            rec.record?.entityId || rec.record?.activeEntityId || r.metadata?.entityId || eid
          ),
          timestamp: Number(r.metadata?.timestamp || 0),
        };
      } catch {
        // record may have been purged/deleted — skip and try the next
      }
    }
    return null;
  }

  /**
   * Pull the latest captcha token captured for an entity.
    * type: "login" | "visa" | "general". Falls back across types unless strict.
   */
  async fetchLatestCaptcha(
    entityId,
    type = "visa",
    { strict = false, refresh = false } = {}
  ) {
    const eid = entityId || this.entityId;
    if (!eid) throw new Error("Entity ID required (pass entityId or --entity)");
    type = String(type).trim().toLowerCase();
    if (!CAPTCHA_TYPES.has(type)) {
      throw new Error(`Invalid CAPTCHA type: ${type}. Use visa, login, or general`);
    }

    try {
      const context = await this.fetchContext(eid, { refresh });
      const captcha = context.captcha || {};
      const preferred = type === "login"
        ? captcha.login
        : type === "general"
          ? captcha.latest
          : captcha.visa;
      const order = strict
        ? [preferred]
        : type === "login"
          ? [captcha.login, captcha.latest, captcha.visa]
          : type === "general"
            ? [captcha.latest, captcha.visa, captcha.login]
            : [captcha.visa, captcha.latest, captcha.login];
      const found = order.find((entry) => entry?.captchaToken);
      if (found) return found.captchaToken;
    } catch {
      // Fall back to individual endpoints during staged Worker upgrades.
    }

    const order = strict
      ? [type]
      : type === "login"
        ? ["login", "general", "visa"]
        : type === "general"
          ? ["general", "visa", "login"]
          : ["visa", "login", "general"];

    for (const t of order) {
      const path =
        t === "login"
          ? `/entity/${encodeURIComponent(eid)}/captcha/login`
          : t === "visa"
            ? `/entity/${encodeURIComponent(eid)}/captcha/visa`
            : `/entity/${encodeURIComponent(eid)}/captcha`;
      try {
        const json = await this._get(path);
        const latest = json.latestCaptcha || json.fallbackGeneralCaptcha || null;
        if (latest?.captchaToken) return latest.captchaToken;
      } catch {
        // try the next captcha type
      }
    }
    return null;
  }

  extractToken(record) {
    if (!record || typeof record !== "object") return null;
    const candidates = [
      record.token,
      record.authToken,
      record.payload?.token,
      record.payload?.authToken,
      record.headers?.request?.authorization,
      record.headers?.captured?.authorization,
      record.headers?.authorization,
      record.authHeader,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) {
        const parsed = parseJwt(c);
        if (parsed) return parsed.token;
      }
    }
    return null;
  }
}
