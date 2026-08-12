/**
 * CapSolver — direct REST API client for fast, concurrent captcha solving
 * on the Masar Nusuk platform.
 *
 * This module talks to the CapSolver REST API directly (createTask →
 * getTaskResult polling → getBalance) using the global `fetch` available in
 * Node 20+. It replaces the deprecated `@captcha-libs/capsolver` SDK, whose
 * dependency tree pulled in the unmaintained `@captcha-libs/captcha-client`
 * and `node-domexception` packages (both emit npm deprecation warnings).
 *
 * Supports:
 *   - reCAPTCHA v2 (ReCaptchaV2TaskProxyLess)
 *   - reCAPTCHA v2 Enterprise (ReCaptchaV2EnterpriseTaskProxyLess)
 *   - reCAPTCHA v3 (ReCaptchaV3TaskProxyLess)
 *   - reCAPTCHA v3 Enterprise (ReCaptchaV3EnterpriseTaskProxyLess)
 *   - Cloudflare Turnstile (AntiTurnstileTaskProxyLess)
 *
 * Usage:
 *   const solver = new CapSolver();
 *   const token = await solver.solve({ version: 2 });
 *
 * Environment variables:
 *   CAPSOLVER_API_KEY    — CapSolver API key (required)
 *   CAPSOLVER_SITE_KEY   — reCAPTCHA site key (default: Nusuk's key)
 *   CAPSOLVER_PAGE_URL   — page URL where the captcha appears
 *   CAPSOLVER_PAGE_ACTION — page action for reCAPTCHA v3 (default: "submit")
 *   CAPSOLVER_MIN_SCORE  — minimum score for v3 (default: 0.7)
 *   CAPSOLVER_API_URL    — API base URL (default: https://api.capsolver.com)
 */

const DEFAULT_SITE_KEY = "6Le-3OwpAAAAAARztuPscqBNbpEY3okMkd7dCoyx";
const DEFAULT_PAGE_URL = "https://masar.nusuk.sa/umrah/mutamer-group/group-list";
const DEFAULT_PAGE_ACTION = "submit";
const DEFAULT_MIN_SCORE = 0.7;
const DEFAULT_API_URL = "https://api.capsolver.com";

export class CapSolver {
  /**
   * @param {object} [config]
   * @param {string} [config.clientKey] — CapSolver API key.
   * @param {string} [config.siteKey] — Captcha site key.
   * @param {string} [config.pageUrl] — Page URL where captcha appears.
   * @param {string} [config.pageAction] — Page action for reCAPTCHA v3.
   * @param {number} [config.minScore] — Minimum score for v3 (0.1–0.9).
   * @param {number} [config.pollingInterval] — Poll interval in ms (default: 2000).
   * @param {number} [config.timeout] — Solve timeout in ms (default: 180000).
   * @param {string} [config.apiUrl] — CapSolver API base URL.
   */
  constructor(config = {}) {
    this.clientKey = config.clientKey || process.env.CAPSOLVER_API_KEY || null;
    this.siteKey = config.siteKey || process.env.CAPSOLVER_SITE_KEY || DEFAULT_SITE_KEY;
    this.pageUrl = config.pageUrl || process.env.CAPSOLVER_PAGE_URL || DEFAULT_PAGE_URL;
    this.pageAction = config.pageAction || process.env.CAPSOLVER_PAGE_ACTION || DEFAULT_PAGE_ACTION;
    this.minScore = config.minScore ?? (process.env.CAPSOLVER_MIN_SCORE ? Number(process.env.CAPSOLVER_MIN_SCORE) : DEFAULT_MIN_SCORE);
    this.pollingInterval = config.pollingInterval ?? 2000;
    this.timeout = config.timeout ?? 180000;
    this.apiUrl = (config.apiUrl || process.env.CAPSOLVER_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
  }

  _assertKey() {
    if (!this.clientKey) {
      throw new Error("CAPSOLVER_API_KEY is required (set the env var or pass clientKey in config)");
    }
  }

  /**
   * POST a JSON body to a CapSolver endpoint and return the parsed response.
   * Throws on network errors or non-zero errorId.
   * @param {string} path — Endpoint path (e.g. "/createTask").
   * @param {object} body — Request body (clientKey is injected automatically).
   * @returns {Promise<object>} Parsed JSON response.
   */
  async _post(path, body) {
    this._assertKey();
    const url = `${this.apiUrl}${path}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: this.clientKey, ...body }),
    });
    if (!resp.ok) {
      throw new Error(`CapSolver ${path} HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    const data = await resp.json();
    if (data.errorId && data.errorId !== 0) {
      const msg = data.errorDescription || data.errorCode || `CapSolver error ${data.errorId}`;
      throw new Error(`CapSolver ${path} failed: ${msg}`);
    }
    return data;
  }

  /**
   * Create a task and poll getTaskResult until ready or timeout.
   * @param {object} task — Task payload (type, websiteURL, websiteKey, ...).
   * @param {number} [timeout] — Solve timeout in ms (default: this.timeout).
   * @returns {Promise<object>} solution object from getTaskResult.
   */
  async _solveTask(task, timeout) {
    const deadline = Date.now() + (timeout ?? this.timeout);
    const { taskId } = await this._post("/createTask", { task });
    if (!taskId) {
      throw new Error("CapSolver createTask returned no taskId");
    }

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollingInterval));
      const result = await this._post("/getTaskResult", { taskId });
      if (result.status === "ready") {
        return result.solution || {};
      }
      if (result.status === "failed") {
        throw new Error(`CapSolver task ${taskId} failed`);
      }
      // status === "processing" → keep polling
    }
    throw new Error(`CapSolver task ${taskId} timed out after ${timeout ?? this.timeout}ms`);
  }

  /**
   * Check the account balance.
   * @returns {Promise<{balance: number}>} Balance info.
   */
  async getBalance() {
    const result = await this._post("/getBalance", {});
    return { balance: result.balance };
  }

  // ─── reCAPTCHA v2 ───────────────────────────────────────────────────

  /**
   * Solve reCAPTCHA v2 (proxyless).
   * @param {object} [options]
   * @param {string} [options.websiteURL] - Override page URL.
   * @param {string} [options.websiteKey] - Override site key.
   * @param {boolean} [options.isInvisible] - Whether the captcha is invisible.
   * @returns {Promise<string>} gRecaptchaResponse token.
   */
  async solveRecaptchaV2(options = {}) {
    const solution = await this._solveTask(
      {
        type: "ReCaptchaV2TaskProxyLess",
        websiteURL: options.websiteURL || this.pageUrl,
        websiteKey: options.websiteKey || this.siteKey,
        isInvisible: options.isInvisible || false,
      },
      options.timeout
    );
    const token = solution?.gRecaptchaResponse;
    if (!token) {
      throw new Error("CapSolver returned no gRecaptchaResponse for reCAPTCHA v2");
    }
    return token;
  }

  /**
   * Solve reCAPTCHA v2 Enterprise (proxyless).
   * @param {object} [options] - Same as solveRecaptchaV2.
   * @returns {Promise<string>} gRecaptchaResponse token.
   */
  async solveRecaptchaV2Enterprise(options = {}) {
    const solution = await this._solveTask(
      {
        type: "ReCaptchaV2EnterpriseTaskProxyLess",
        websiteURL: options.websiteURL || this.pageUrl,
        websiteKey: options.websiteKey || this.siteKey,
        isInvisible: options.isInvisible || false,
      },
      options.timeout
    );
    const token = solution?.gRecaptchaResponse;
    if (!token) {
      throw new Error("CapSolver returned no gRecaptchaResponse for reCAPTCHA v2 Enterprise");
    }
    return token;
  }

  // ─── reCAPTCHA v3 ───────────────────────────────────────────────────

  /**
   * Solve reCAPTCHA v3 (proxyless).
   * @param {object} [options]
   * @param {string} [options.websiteURL] - Override page URL.
   * @param {string} [options.websiteKey] - Override site key.
   * @param {string} [options.pageAction] - Page action (default: "submit").
   * @param {number} [options.minScore] - Minimum score (0.1–0.9).
   * @returns {Promise<string>} gRecaptchaResponse token.
   */
  async solveRecaptchaV3(options = {}) {
    const solution = await this._solveTask(
      {
        type: "ReCaptchaV3TaskProxyLess",
        websiteURL: options.websiteURL || this.pageUrl,
        websiteKey: options.websiteKey || this.siteKey,
        pageAction: options.pageAction || this.pageAction,
        minScore: options.minScore ?? this.minScore,
      },
      options.timeout
    );
    const token = solution?.gRecaptchaResponse;
    if (!token) {
      throw new Error("CapSolver returned no gRecaptchaResponse for reCAPTCHA v3");
    }
    return token;
  }

  /**
   * Solve reCAPTCHA v3 Enterprise (proxyless).
   * @param {object} [options] - Same as solveRecaptchaV3.
   * @returns {Promise<string>} gRecaptchaResponse token.
   */
  async solveRecaptchaV3Enterprise(options = {}) {
    const solution = await this._solveTask(
      {
        type: "ReCaptchaV3EnterpriseTaskProxyLess",
        websiteURL: options.websiteURL || this.pageUrl,
        websiteKey: options.websiteKey || this.siteKey,
        pageAction: options.pageAction || this.pageAction,
        minScore: options.minScore ?? this.minScore,
      },
      options.timeout
    );
    const token = solution?.gRecaptchaResponse;
    if (!token) {
      throw new Error("CapSolver returned no gRecaptchaResponse for reCAPTCHA v3 Enterprise");
    }
    return token;
  }

  // ─── Cloudflare Turnstile ───────────────────────────────────────────

  /**
   * Solve Cloudflare Turnstile.
   * @param {object} [options]
   * @param {string} [options.websiteURL] - Override page URL.
   * @param {string} [options.websiteKey] - Turnstile site key.
   * @returns {Promise<string>} Turnstile token.
   */
  async solveTurnstile(options = {}) {
    const solution = await this._solveTask(
      {
        type: "AntiTurnstileTaskProxyLess",
        websiteURL: options.websiteURL || this.pageUrl,
        websiteKey: options.websiteKey || this.siteKey,
      },
      options.timeout
    );
    const token = solution?.token || solution?.gRecaptchaResponse;
    if (!token) {
      throw new Error("CapSolver returned no token for Turnstile");
    }
    return token;
  }

  // ─── Unified solve ──────────────────────────────────────────────────

  /**
   * Unified solve method — dispatches to the right solver based on type/version.
   *
   * @param {object} [options]
   * @param {number} [options.version=2] - reCAPTCHA version (2 or 3).
   * @param {string} [options.type="recaptcha"] - Captcha type: "recaptcha", "turnstile".
   * @param {boolean} [options.enterprise] - Use Enterprise variant.
   * @param {string} [options.captchaType] - Nusuk captcha type for compat ("visa", "login", "general").
   * @param {number} [options.timeout] - Solve timeout in ms.
   * @returns {Promise<string>} Captcha token.
   */
  async solve({ version = 2, type = "recaptcha", enterprise = false, captchaType, timeout } = {}) {
    // "visa"/"login"/"general" are Nusuk captcha types — they all use reCAPTCHA
    const isRecaptcha = type === "recaptcha" || ["visa", "login", "general"].includes(type);

    if (type === "turnstile") {
      return this.solveTurnstile({ timeout });
    }

    if (isRecaptcha) {
      if (version === 3) {
        return enterprise
          ? this.solveRecaptchaV3Enterprise({ timeout })
          : this.solveRecaptchaV3({ timeout });
      }
      return enterprise
        ? this.solveRecaptchaV2Enterprise({ timeout })
        : this.solveRecaptchaV2({ timeout });
    }

    throw new Error(`Unknown captcha type: ${type}`);
  }
}
