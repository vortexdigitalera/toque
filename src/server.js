/**
 * HTTP server entry point for the Cloudflare Container.
 *
 * Exposes the Nusuk CLI operations as JSON endpoints so the Cloudflare Worker
 * can route requests to the container. The container persists auth, entity,
 * and captcha values to local files (auth.json, captcha.json, entity.json)
 * so subsequent commands auto-read them without env vars.
 */

import { createServer } from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { Nusuk } from "./nusuk.js";
import { AuthaWorker } from "./worker.js";
import { CapSolver } from "./capsolver.js";
import { CapMonsterSolver } from "./capmonster.js";
import { buildVisaPayload } from "./visa-payload.js";
import { buildLoginRequest, DEFAULT_TRUSTED_DEVICE_TOKEN } from "./nusuk-crypto.js";
import { parseJwt } from "./jwt.js";
import { getRequest, listRequests } from "./requests.js";
import { extractGroups, formatGroups, normalizeGroupId } from "./groups.js";
import { computeSendSchedule } from "./scheduling.js";
import { parsePositiveCount, parseTargetTime } from "./validation.js";
import { pullCaptchaOnce, runCaptchaPullLoop, normalizeCaptchaType, parseInterval } from "./captcha-puller.js";
import { jsonResponse, writePrivateJson, readJsonIfExists } from "./utils.js";
import { log } from "./log.js";

const PORT = Number(process.env.PORT || 8080);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const CLI_PATH = resolve(PROJECT_ROOT, "bin/nusuk.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function buildNusuk(body = {}) {
  const nusuk = new Nusuk({
    baseUrl: body.baseUrl || process.env.NUSUK_BASE_URL,
    origin: body.origin || process.env.NUSUK_ORIGIN,
    referer: body.referer || process.env.NUSUK_REFERER,
    browserOptions: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--single-process",
      ],
    },
  });

  const skipAuth = body.skipAuth === true;
  const authToken = body.authToken || process.env.AUTH_TOKEN || process.env.NUSUK_AUTH_TOKEN;
  if (authToken) {
    nusuk.setAuthToken(authToken);
  } else if (!skipAuth) {
    nusuk.loadAuth();
  }

  nusuk.loadEntity({
    activeEntityId: body.activeEntityId || process.env.ACTIVE_ENTITY_ID,
    activeEntityTypeId: body.activeEntityTypeId || process.env.ACTIVE_ENTITY_TYPE_ID,
  });

  const skipCaptcha = body.skipCaptcha === true;
  const captchaType = body.captchaType || process.env.CAPTCHA_TYPE || "visa";
  const captchaToken = body.captchaToken || process.env.CAPTCHA_TOKEN;
  if (captchaToken) {
    nusuk.captchaToken = captchaToken;
  } else if (!skipCaptcha) {
    nusuk.loadCaptcha(undefined, captchaType);
  }

  return nusuk;
}

async function withNusuk(body, callback) {
  const nusuk = buildNusuk(body);
  await nusuk.init();
  try {
    return await callback(nusuk);
  } finally {
    await nusuk.close();
  }
}

// ---------------------------------------------------------------------------
// Pull handler — persists pulled context to local files
// ---------------------------------------------------------------------------

async function handlePull(body) {
  // In proxy mode, AUTHA_PROXY_URL is set and WORKER_API_TOKEN is not needed
  // (the Worker injects it via the service binding). In direct mode, both
  // WORKER_URL and WORKER_API_TOKEN are required.
  const proxyMode = Boolean(process.env.AUTHA_PROXY_URL);
  if (!proxyMode) {
    requireEnv(["WORKER_URL", "WORKER_API_TOKEN"]);
  }
  const worker = new AuthaWorker({
    endpoint: proxyMode ? undefined : process.env.WORKER_URL,
    apiToken: proxyMode ? undefined : process.env.WORKER_API_TOKEN,
    entityId: body.activeEntityId || process.env.ACTIVE_ENTITY_ID,
    systemUserId: body.systemUserId || process.env.SYSTEM_USER_ID,
  });
  const context = await worker.fetchContext(undefined, { refresh: Boolean(body.refresh) });

  const authPath = process.env.AUTH_PATH || "auth.json";
  const captchaPath = process.env.CAPTCHA_PATH || "captcha.json";
  const entityPath = process.env.ENTITY_CONFIG_PATH || "entity.json";

  const entityId = context.entityId || context.entity?.entityId;
  const token = worker.extractToken(context.auth);
  const captchaOptions = context.captcha || {};
  const captcha =
    captchaOptions.visa?.captchaToken ||
    captchaOptions.latest?.captchaToken ||
    captchaOptions.login?.captchaToken ||
    null;

  if (token) {
    const existingAuth = readJsonIfExists(authPath, {});
    existingAuth.response = existingAuth.response || { data: { authInfo: {} } };
    existingAuth.response.data = existingAuth.response.data || { authInfo: {} };
    existingAuth.response.data.authInfo = existingAuth.response.data.authInfo || {};
    existingAuth.response.data.authInfo.userToken = token;
    if (entityId) existingAuth.response.data.authInfo.entityId = entityId;
    writePrivateJson(authPath, existingAuth);
  }

  if (captcha) {
    const existingCaptcha = readJsonIfExists(captchaPath, {});
    existingCaptcha.visa = captcha;
    existingCaptcha.captchaToken = captcha;
    existingCaptcha.entityId = existingCaptcha.entityId || entityId;
    existingCaptcha.updatedAt = new Date().toISOString();
    writePrivateJson(captchaPath, existingCaptcha);
  }

  if (entityId || context.systemUserId) {
    const existingEntity = readJsonIfExists(entityPath, {});
    const capturedEntity = context.entity || {};
    existingEntity.activeEntityId = capturedEntity.activeEntityId || capturedEntity.entityId || entityId;
    existingEntity.activeEntityTypeId = capturedEntity.activeEntityTypeId || existingEntity.activeEntityTypeId;
    existingEntity.entityId = capturedEntity.entityId || entityId;
    existingEntity.entityTypeId = capturedEntity.entityTypeId || existingEntity.entityTypeId;
    existingEntity.systemUserId = context.systemUserId || worker.systemUserId;
    writePrivateJson(entityPath, existingEntity);
  }

  return {
    ok: true,
    context,
    saved: {
      auth: Boolean(token),
      captcha: Boolean(captcha),
      entityId: entityId || null,
      systemUserId: context.systemUserId || worker.systemUserId || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Nusuk-backed handlers
// ---------------------------------------------------------------------------

async function handleInfo(body) {
  return withNusuk(body, async (nusuk) => {
    const res = await nusuk.request(
      "/umrah/reports_apis/api/Dashboard/DashboardCompanyInfo",
      { method: "POST", payload: {} }
    );
    return { ok: res.ok, status: res.status, data: res.json };
  });
}

async function handleSend(body) {
  const groupId = normalizeGroupId(body.groupId);
  if (!groupId) throw new Error("groupId is required");
  return withNusuk(body, async (nusuk) => {
    const payload = buildVisaPayload(body.payload, groupId, nusuk.captchaToken);
    const res = await nusuk.request(
      "/umrah/groups_apis/api/Groups/SendToIssueVisa",
      { method: "POST", payload }
    );
    return { ok: res.ok, status: res.status, data: res.json, timing: res.timing };
  });
}

async function handleApi(body) {
  const name = String(body.name || "").trim().toLowerCase();
  const request = getRequest(name);
  if (!request) throw new Error(`Unknown API request: ${body.name}`);
  // Skip captcha loading when the catalog entry doesn't need it — avoids
  // requiring captcha.json for endpoints that never send a captchaToken.
  const effectiveBody = request.captcha ? body : { ...body, skipCaptcha: true };
  return withNusuk(effectiveBody, async (nusuk) => {
    let payload = { ...request.payload };
    if (request.captcha) {
      const field = request.captchaField || "captchaToken";
      payload[field] = nusuk.captchaToken;
    }
    if (body.payload) {
      payload = { ...payload, ...body.payload };
    }
    const headers = { ...(request.extraHeaders || {}), ...(body.headers || {}) };
    const res = await nusuk.request(request.path, {
      method: request.method,
      payload,
      headers,
    });
    return { ok: res.ok, status: res.status, data: res.json, timing: res.timing };
  });
}

async function handleRequest(body) {
  if (!body.path) throw new Error("path is required");
  return withNusuk(body, async (nusuk) => {
    const res = await nusuk.request(body.path, {
      method: body.method || "GET",
      payload: body.payload,
      headers: body.headers || {},
    });
    return { ok: res.ok, status: res.status, data: res.json || res.body, timing: res.timing };
  });
}

async function handleGroups(body) {
  return withNusuk(body, async (nusuk) => {
    const limit = parsePositiveCount(body.limit) || 10;
    const offset = parsePositiveCount(body.offset) || 0;
    const res = await nusuk.request("/umrah/groups_apis/api/Groups/GetGroupList", {
      method: "POST",
      payload: {
        limit,
        offset,
        filterList: [],
        sortColumn: null,
        sortCriteria: [],
        noCount: true,
      },
    });
    const groups = extractGroups(res.json);
    return {
      ok: res.ok,
      status: res.status,
      groups: formatGroups(groups),
      raw: body.raw ? res.json : undefined,
    };
  });
}

async function handleAutoLogin(body = {}) {
  // Auto-login: solve a CAPTCHA, encrypt credentials, send login request,
  // and save the returned JWT to auth.json.
  const provider = body.provider || process.env.CAPTCHA_PROVIDER || "capmonster";
  const siteKey = body.siteKey || process.env.CAPTCHA_SITE_KEY || process.env.CAPMONSTER_SITE_KEY || "6Le-3OwpAAAAAARztuPscqBNbpEY3okMkd7dCoyx";
  const pageUrl = body.pageUrl || process.env.CAPTCHA_PAGE_URL || "https://masar.nusuk.sa/pub/login";

  // Require username/password for credential encryption
  const username = body.username || process.env.NUSUK_USERNAME;
  const password = body.password || process.env.NUSUK_PASSWORD;
  if (!username || !password) {
    throw new Error("username and password are required (pass in body or set NUSUK_USERNAME/NUSUK_PASSWORD env vars)");
  }

  let captchaToken;
  if (provider === "capmonster") {
    const solver = new CapMonsterSolver({
      clientKey: process.env.CAPMONSTER_API_KEY,
      siteKey,
      pageUrl,
      pageAction: body.pageAction || process.env.CAPMONSTER_PAGE_ACTION,
    });
    captchaToken = await solver.solve({
      version: body.captchaVersion || 2,
      type: body.captchaType || "recaptcha",
      enterprise: body.enterprise || false,
      timeout: body.timeout || 180000,
    });
  } else {
    requireEnv(["CAPSOLVER_API_KEY"]);
    const solver = new CapSolver({
      clientKey: process.env.CAPSOLVER_API_KEY,
      siteKey: body.siteKey || process.env.CAPSOLVER_SITE_KEY || siteKey,
      pageUrl: body.pageUrl || process.env.CAPSOLVER_PAGE_URL || pageUrl,
      pageAction: body.pageAction || process.env.CAPSOLVER_PAGE_ACTION,
    });
    captchaToken = await solver.solve();
  }

  // Build the login payload and headers using Nusuk's encryption
  const { payload: loginPayload, headers: loginHeaders } = buildLoginRequest({
    username,
    password,
    captchaToken,
    key: body.aesKey || process.env.NUSUK_AES_KEY,
    xChannel: body.xChannel || process.env.X_CHANNEL,
    trustedDeviceToken: body.trustedDeviceToken || process.env.TRUSTED_DEVICE_TOKEN || DEFAULT_TRUSTED_DEVICE_TOKEN,
  });

  return withNusuk({ ...body, skipAuth: true, skipCaptcha: true }, async (nusuk) => {
    const res = await nusuk.request("/eh/public/authentication/login", {
      method: "POST",
      payload: loginPayload,
      headers: loginHeaders,
    });

    // Save the JWT token if login succeeded
    // The login response has two paths:
    //   - trustedDevice=true:  response.data.authInfo.{token,userToken,refreshToken,permsToken}
    //     → userToken is the AUTH_TOKEN (type 3) with entity claims — save it.
    //   - trustedDevice=false: response.data.token is a TEMP_TOKEN (type 2),
    //     authInfo is null, OTP is required.
    //     → Do NOT save the temp token as userToken — it lacks entity claims
    //       and will cause all authenticated requests to fail. Only return it
    //       as intermediateToken for the verify-login step.
    const authInfo = res.json?.response?.data?.authInfo;
    const trustedDevice = res.json?.response?.data?.trustedDevice;
    const intermediateToken = res.json?.response?.data?.token;
    const transactionId = res.json?.response?.data?.transactionId;
    // Use tokenType from the JWT to reliably detect temp tokens (type 2)
    // instead of the fragile `otpType !== undefined && authInfo === null` check.
    const intermediateJwt = intermediateToken ? parseJwt(intermediateToken) : null;
    const isTempToken = intermediateJwt?.payload?.tokenType === 2;
    const otpRequired = trustedDevice === false || isTempToken || (authInfo === null && transactionId !== undefined);
    // Only save the AUTH_TOKEN (type 3) — never the temp token
    const token = authInfo?.userToken || authInfo?.token;
    if (token) {
      const authPath = process.env.AUTH_PATH || "auth.json";
      const existing = readJsonIfExists(authPath, {});
      existing.response = existing.response || { data: { authInfo: {} } };
      existing.response.data = existing.response.data || { authInfo: {} };
      existing.response.data.authInfo = existing.response.data.authInfo || {};
      existing.response.data.authInfo.userToken = token;
      // Save all tokens from the response for completeness
      if (authInfo?.refreshToken) existing.response.data.authInfo.refreshToken = authInfo.refreshToken;
      if (authInfo?.permsToken) existing.response.data.authInfo.permsToken = authInfo.permsToken;
      if (authInfo?.token) existing.response.data.authInfo.token = authInfo.token;
      // The login response has entityId=null at the authInfo level, but the
      // JWT payload carries defaultEntityId/defaultEntityTypeId. Extract them
      // so loadAuth() can set the activeentityid header for authenticated calls.
      const jwt = parseJwt(token);
      const entityId = authInfo?.entityId || jwt?.payload?.defaultEntityId || jwt?.payload?.entities?.[0]?.entityId;
      const entityTypeId = authInfo?.entityTypeId || jwt?.payload?.defaultEntityTypeId || jwt?.payload?.entities?.[0]?.entityTypeId;
      if (entityId) existing.response.data.authInfo.entityId = entityId;
      if (entityTypeId) existing.response.data.authInfo.entityTypeId = entityTypeId;
      writePrivateJson(authPath, existing);
    }

    // Save the login profile for later token refresh
    const profilePath = process.env.PROFILE_PATH || "profile.json";
    const profile = {
      username,
      password,
      aesKey: body.aesKey || process.env.NUSUK_AES_KEY || undefined,
      xChannel: body.xChannel || process.env.X_CHANNEL || undefined,
      trustedDeviceToken: body.trustedDeviceToken || process.env.TRUSTED_DEVICE_TOKEN || undefined,
      captcha: { provider, siteKey, pageUrl, captchaVersion: body.captchaVersion || 2, captchaType: body.captchaType || "recaptcha", enterprise: body.enterprise || false },
      lastLoginAt: new Date().toISOString(),
      lastLoginStatus: token ? "ok" : "failed",
      trustedDevice: trustedDevice ?? null,
      transactionId: res.json?.response?.data?.transactionId || null,
    };
    writePrivateJson(profilePath, profile);

    return {
      ok: res.ok,
      status: res.status,
      data: res.json,
      captchaToken,
      saved: Boolean(token),
      otpRequired,
      transactionId,
      intermediateToken: otpRequired ? intermediateToken : undefined,
      timing: res.timing,
    };
  });
}

async function handleVerifyLogin(body = {}) {
  // Verify OTP after auto-login. Requires the transactionId from the login
  // response and the OTP code sent to the user's email/phone.
  const transactionId = body.transactionId;
  if (!transactionId) throw new Error("transactionId is required (from /login response)");
  const otpCode = body.otpCode;
  if (!otpCode) throw new Error("otpCode is required (the OTP sent to email/phone)");

  const system = body.system || "1";
  const module = body.module || "1";

  // Build the verify payload
  const verifyPayload = {
    transactionId,
    system,
    module,
    otpCode,
  };

  // Generate a fresh otpTimeStamp for the verify request
  const { buildOtpTimeStamp } = await import("./nusuk-crypto.js");
  verifyPayload.otpTimeStamp = buildOtpTimeStamp(body.aesKey || process.env.NUSUK_AES_KEY);

  return withNusuk({ ...body, skipAuth: true, skipCaptcha: true }, async (nusuk) => {
    const res = await nusuk.request("/eh/public/authentication/verifyLogin", {
      method: "POST",
      payload: verifyPayload,
    });

    // Save the JWT token if verification succeeded
    // The verifyLogin response has the full AUTH_TOKEN with entity claims.
    // Response structure: response.data.{token, userToken, refreshToken, permsToken}
    // or response.data.authInfo.{userToken, refreshToken, permsToken}
    const data = res.json?.response?.data;
    const authInfo = data?.authInfo || data;
    const token = authInfo?.userToken || authInfo?.token || data?.token;
    if (token) {
      const authPath = process.env.AUTH_PATH || "auth.json";
      const existing = readJsonIfExists(authPath, {});
      existing.response = existing.response || { data: { authInfo: {} } };
      existing.response.data = existing.response.data || { authInfo: {} };
      existing.response.data.authInfo = existing.response.data.authInfo || {};
      existing.response.data.authInfo.userToken = token;
      // Save all tokens from the response for completeness
      if (authInfo?.refreshToken) existing.response.data.authInfo.refreshToken = authInfo.refreshToken;
      if (authInfo?.permsToken) existing.response.data.authInfo.permsToken = authInfo.permsToken;
      if (authInfo?.token) existing.response.data.authInfo.token = authInfo.token;
      // Extract entity info from the JWT payload (the AUTH_TOKEN has
      // defaultEntityId/defaultEntityTypeId/entities claims) so loadAuth()
      // can set the activeentityid header for authenticated calls.
      const jwt = parseJwt(token);
      const entityId = authInfo?.entityId || jwt?.payload?.defaultEntityId || jwt?.payload?.entities?.[0]?.entityId;
      const entityTypeId = authInfo?.entityTypeId || jwt?.payload?.defaultEntityTypeId || jwt?.payload?.entities?.[0]?.entityTypeId;
      if (entityId) existing.response.data.authInfo.entityId = entityId;
      if (entityTypeId) existing.response.data.authInfo.entityTypeId = entityTypeId;
      writePrivateJson(authPath, existing);
    }

    // Update profile with verify status
    const profilePath = process.env.PROFILE_PATH || "profile.json";
    try {
      const profile = readJsonIfExists(profilePath, {});
      profile.lastVerifyAt = new Date().toISOString();
      profile.lastVerifyStatus = token ? "ok" : "failed";
      writePrivateJson(profilePath, profile);
    } catch { /* profile doesn't exist yet — skip */ }

    return {
      ok: res.ok,
      status: res.status,
      data: res.json,
      saved: Boolean(token),
      timing: res.timing,
    };
  });
}

async function handleRefreshToken(body = {}) {
  // Refresh the auth token using the stored refresh token from auth.json.
  // If no refresh token is available, falls back to a full re-login using
  // the saved profile (profile.json from a previous /login).
  const authPath = process.env.AUTH_PATH || "auth.json";
  const existing = readJsonIfExists(authPath, {});
  const refreshToken = existing?.response?.data?.authInfo?.refreshToken;

  if (refreshToken) {
    return withNusuk({ ...body, skipAuth: true, skipCaptcha: true }, async (nusuk) => {
      const res = await nusuk.request("/eh/public/authentication/refreshToken", {
        method: "POST",
        payload: { refreshToken },
      });

      const data = res.json?.response?.data;
      const newToken = data?.userToken || data?.token;
      if (newToken) {
        existing.response.data.authInfo.userToken = newToken;
        if (data?.refreshToken) existing.response.data.authInfo.refreshToken = data.refreshToken;
        if (data?.permsToken) existing.response.data.authInfo.permsToken = data.permsToken;
        if (data?.token) existing.response.data.authInfo.token = data.token;
        const jwt = parseJwt(newToken);
        const entityId = jwt?.payload?.defaultEntityId || jwt?.payload?.entities?.[0]?.entityId;
        const entityTypeId = jwt?.payload?.defaultEntityTypeId || jwt?.payload?.entities?.[0]?.entityTypeId;
        if (entityId) existing.response.data.authInfo.entityId = entityId;
        if (entityTypeId) existing.response.data.authInfo.entityTypeId = entityTypeId;
        writePrivateJson(authPath, existing);
      }

      return {
        ok: res.ok,
        status: res.status,
        data: res.json,
        saved: Boolean(newToken),
        method: "refreshToken",
        timing: res.timing,
      };
    });
  }

  // No refresh token — fall back to full re-login using saved profile
  const profilePath = process.env.PROFILE_PATH || "profile.json";
  const profile = readJsonIfExists(profilePath, null);
  if (!profile || !profile.username || !profile.password) {
    throw new Error("No refresh token and no saved profile. Call /login first to create a profile.");
  }
  return handleAutoLogin({
    ...body,
    username: profile.username,
    password: profile.password,
    aesKey: profile.aesKey,
    xChannel: profile.xChannel,
    trustedDeviceToken: profile.trustedDeviceToken,
    provider: profile.captcha?.provider,
    siteKey: profile.captcha?.siteKey,
    pageUrl: profile.captcha?.pageUrl,
    captchaVersion: profile.captcha?.captchaVersion,
    captchaType: profile.captcha?.captchaType,
    enterprise: profile.captcha?.enterprise,
  });
}

async function handleCaptchaSolve(body) {
  const provider = body.provider || (process.env.CAPTCHA_PROVIDER || "capsolver");

  if (provider === "capmonster") {
    const solver = new CapMonsterSolver({
      clientKey: process.env.CAPMONSTER_API_KEY,
      siteKey: body.siteKey || process.env.CAPMONSTER_SITE_KEY,
      pageUrl: body.pageUrl || process.env.CAPMONSTER_PAGE_URL,
      pageAction: body.pageAction || process.env.CAPMONSTER_PAGE_ACTION,
    });
    const token = await solver.solve({
      version: body.version || 2,
      type: body.captchaType || "recaptcha",
      enterprise: body.enterprise || false,
      timeout: body.timeout || 180000,
    });
    return { ok: true, token, provider: "capmonster" };
  }

  // Default: CapSolver
  requireEnv(["CAPSOLVER_API_KEY"]);
  const solver = new CapSolver({
    clientKey: process.env.CAPSOLVER_API_KEY,
    siteKey: body.siteKey || process.env.CAPSOLVER_SITE_KEY,
    pageUrl: body.pageUrl || process.env.CAPSOLVER_PAGE_URL,
    pageAction: body.pageAction || process.env.CAPSOLVER_PAGE_ACTION,
  });
  const token = await solver.solve();
  return { ok: true, token, provider: "capsolver" };
}

async function handleCaptchaBalance(body = {}) {
  const provider = body.provider || (process.env.CAPTCHA_PROVIDER || "capsolver");

  if (provider === "capmonster") {
    const solver = new CapMonsterSolver({
      clientKey: process.env.CAPMONSTER_API_KEY,
    });
    const { balance } = await solver.getBalance();
    return { ok: true, balance, provider: "capmonster" };
  }

  // CapSolver — use the SDK
  requireEnv(["CAPSOLVER_API_KEY"]);
  const capSolver = new CapSolver({
    clientKey: process.env.CAPSOLVER_API_KEY,
  });
  const { balance } = await capSolver.getBalance();
  return { ok: true, balance, provider: "capsolver" };
}

async function handleSchedule(body) {
  const target = parseTargetTime(body.target);
  if (!target) throw new Error("target time is required (HH:MM:SS[.mmm])");
  const groupId = normalizeGroupId(body.groupId);
  if (!groupId) throw new Error("groupId is required");

  return withNusuk(body, async (nusuk) => {
    const schedule = computeSendSchedule(target);
    const payload = buildVisaPayload(body.payload, groupId, nusuk.captchaToken);

    if (schedule.waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, schedule.waitMs));
    }

    const res = await nusuk.request(
      "/umrah/groups_apis/api/Groups/SendToIssueVisa",
      { method: "POST", payload }
    );
    return {
      ok: res.ok,
      status: res.status,
      data: res.json,
      timing: res.timing,
      scheduledAt: schedule.target.toISOString(),
      firedAt: new Date().toISOString(),
    };
  });
}

async function handleListApis() {
  return { ok: true, requests: listRequests() };
}

// ---------------------------------------------------------------------------
// In-process background CAPTCHA refresher
// ---------------------------------------------------------------------------

const captchaTask = {
  controller: null,
  startedAt: null,
  options: null,
  pulls: 0,
  errors: 0,
  lastResult: null,
  lastError: null,
};

function captchaTaskStatus() {
  const running = Boolean(captchaTask.controller && !captchaTask.controller.signal.aborted);
  return {
    running,
    startedAt: captchaTask.startedAt ? captchaTask.startedAt.toISOString() : null,
    uptimeMs: running && captchaTask.startedAt ? Date.now() - captchaTask.startedAt.getTime() : 0,
    options: captchaTask.options,
    pulls: captchaTask.pulls,
    errors: captchaTask.errors,
    lastResult: captchaTask.lastResult,
    lastError: captchaTask.lastError,
  };
}

function captchaTaskStop() {
  if (captchaTask.controller) captchaTask.controller.abort();
  return captchaTaskStatus();
}

async function captchaTaskStart(options = {}) {
  if (captchaTask.controller) captchaTask.controller.abort();

  const entityId = options.entityId || process.env.ACTIVE_ENTITY_ID;
  if (!entityId) throw new Error("Entity ID required (pass --entity or set ACTIVE_ENTITY_ID)");

  const type = normalizeCaptchaType(options.type || "visa");
  const interval = parseInterval(options.interval, 5000);
  // In proxy mode, don't pass endpoint — AuthaWorker constructor picks up
  // AUTHA_PROXY_URL automatically.
  const endpoint = options.endpoint || (process.env.AUTHA_PROXY_URL ? undefined : process.env.WORKER_URL);
  const outputPath = options.output || process.env.CAPTCHA_PATH || "captcha.json";
  const strict = options.strict !== false;

  const controller = new AbortController();
  captchaTask.controller = controller;
  captchaTask.startedAt = new Date();
  captchaTask.options = { entityId, type, interval, endpoint, outputPath, strict };
  captchaTask.pulls = 0;
  captchaTask.errors = 0;
  captchaTask.lastResult = null;
  captchaTask.lastError = null;

  runCaptchaPullLoop({
    entityId,
    type,
    endpoint,
    outputPath,
    strict,
    interval,
    signal: controller.signal,
    quiet: true,
    logger: {
      log: () => { captchaTask.pulls += 1; },
      error: (msg) => { captchaTask.errors += 1; captchaTask.lastError = String(msg); },
    },
  }).then(() => {
    captchaTask.controller = null;
  }).catch((err) => {
    captchaTask.lastError = err.message;
    captchaTask.controller = null;
  });

  return captchaTaskStatus();
}

async function captchaWatchBounded(options = {}) {
  const entityId = options.entityId || process.env.ACTIVE_ENTITY_ID;
  if (!entityId) throw new Error("Entity ID required (pass --entity or set ACTIVE_ENTITY_ID)");

  const type = normalizeCaptchaType(options.type || "visa");
  const interval = parseInterval(options.interval, 5000);
  const maxDuration = Math.min(Number(options.maxDuration) || 60_000, 300_000);
  // In proxy mode, don't pass endpoint — AuthaWorker constructor picks up
  // AUTHA_PROXY_URL automatically.
  const endpoint = options.endpoint || (process.env.AUTHA_PROXY_URL ? undefined : process.env.WORKER_URL);
  const outputPath = options.output || process.env.CAPTCHA_PATH || "captcha.json";
  const strict = options.strict !== false;

  const controller = new AbortController();
  const results = [];
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), maxDuration);

  try {
    while (!controller.signal.aborted) {
      try {
        const result = await pullCaptchaOnce({ entityId, type, endpoint, outputPath, strict });
        results.push({ at: new Date().toISOString(), updated: result.updated, ok: true });
      } catch (err) {
        results.push({ at: new Date().toISOString(), updated: false, ok: false, error: err.message });
      }
      if (controller.signal.aborted) break;
      await new Promise((r) => setTimeout(r, interval));
      if (Date.now() - startedAt >= maxDuration) break;
    }
  } finally {
    clearTimeout(timeout);
  }

  return { ok: true, durationMs: Date.now() - startedAt, pulls: results.length, results };
}

// ---------------------------------------------------------------------------
// Unified /cmd endpoint — run any CLI command and return structured output
// ---------------------------------------------------------------------------

const CMD_CATALOG = {
  init:             { args: [],                          description: "Create local config files" },
  login:            { args: ["--system-user", "--type", "--endpoint"], description: "Install latest user credentials" },
  "login-auto":     { args: ["--capmonster", "--provider", "--username", "--password", "--site-key", "--page-url", "--x-channel", "--trusted-device-token", "--captcha-version", "--captcha-type", "--enterprise"], description: "Auto-login via captcha solver and save JWT" },
  "verify-login":   { args: ["--transaction-id", "--otp", "--system", "--module"], description: "Verify OTP after auto-login" },
  "refresh-token":  { args: [],                          description: "Refresh JWT via stored refresh token or saved profile" },
  logout:           { args: [],                          description: "Clear local auth/captcha/entity state" },
  pull:             { args: ["--entity", "--type", "--endpoint"], description: "Refresh auth, entity, and CAPTCHA" },
  info:             { args: [],                          description: "Show dashboard company info" },
  send:             { args: ["--target", "--data", "--captcha", "--captcha-type", "--no-test", "--endpoint"], description: "Send a visa request" },
  "send-visa":      { args: ["--target", "--data", "--captcha", "--captcha-type", "--no-test", "--endpoint"], description: "Send a visa request (alias)" },
  "set-group-id":   { args: [],                          description: "Store a default group ID" },
  request:          { args: ["--data", "--data-raw", "--captcha", "--captcha-type", "--raw-json"], description: "Send a custom API request" },
  api:              { args: ["--raw-json"],               description: "Run a saved request from the catalog" },
  groups:           { args: ["--limit", "--offset", "--raw-json"], description: "List groups" },
  schedule:         { args: ["--target", "--path", "--method", "--count", "--data", "--captcha", "--captcha-type"], description: "Schedule a timed request" },
  workflow:         { args: ["status", "terminate"],      description: "Manage Cloudflare Workflow instances" },
  "sync-time":      { args: ["--dry-run", "--source"],   description: "Sync system clock to network time" },
  bench:            { args: [],                          description: "Measure request latency" },
  "captcha-pull":   { args: ["--entity", "--type", "--endpoint", "--output", "--quiet"], description: "Pull one CAPTCHA" },
  "captcha-set":    { args: ["--type", "--token"],       description: "Save a CAPTCHA token" },
  "captcha-show":   { args: [],                          description: "Show the saved token" },
  "captcha-solve":  { args: ["--v3", "--type", "--capmonster", "--enterprise", "--turnstile"], description: "Solve CAPTCHA via CapSolver (default) or CapMonster (--capmonster)" },
  "captcha-balance": { args: ["--capmonster"],                   description: "Check solver account balance" },
  "captcha-watch":  { args: ["--entity", "--type", "--interval", "--max-duration", "--endpoint", "--output"], description: "Watch CAPTCHA for a bounded duration (in-process)" },
  "captcha-start":  { args: ["--entity", "--type", "--interval", "--endpoint", "--output"], description: "Start in-process background CAPTCHA refresher" },
  "captcha-status": { args: [],                          description: "Show background refresher status" },
  "captcha-stop":   { args: [],                          description: "Stop the background refresher" },
  help:             { args: [],                          description: "Show CLI help" },
};

function parseCmdRequest(body) {
  if (Array.isArray(body.argv)) return body.argv.map(String);
  if (body.command) {
    const cmd = String(body.command).trim();
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    return [cmd, ...args];
  }
  return null;
}

function getArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

function parseCaptchaWatchArgs(argv, body = {}) {
  return {
    entityId: getArg(argv, "--entity") || body.entityId || process.env.ACTIVE_ENTITY_ID,
    type: getArg(argv, "--type") || body.type || "visa",
    interval: getArg(argv, "--interval") || body.interval || "5s",
    maxDuration: getArg(argv, "--max-duration") || body.maxDuration || 60_000,
    endpoint: getArg(argv, "--endpoint") || body.endpoint || process.env.WORKER_URL,
    output: getArg(argv, "--output") || body.output || process.env.CAPTCHA_PATH || "captcha.json",
    strict: body.strict !== false,
  };
}

function parseCaptchaStartArgs(argv, body = {}) {
  return {
    entityId: getArg(argv, "--entity") || body.entityId || process.env.ACTIVE_ENTITY_ID,
    type: getArg(argv, "--type") || body.type || "visa",
    interval: getArg(argv, "--interval") || body.interval || "5s",
    endpoint: getArg(argv, "--endpoint") || body.endpoint || process.env.WORKER_URL,
    output: getArg(argv, "--output") || body.output || process.env.CAPTCHA_PATH || "captcha.json",
    strict: body.strict !== false,
  };
}

function runCliCommand(argv, options = {}) {
  const timeout = options.timeout ?? 30_000;
  const cwd = options.cwd ?? PROJECT_ROOT;

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argv], {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        command: `nusuk ${argv.join(" ")}`,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        exitCode: -1,
        stdout: stdout.trim(),
        stderr: err.message,
        timedOut: false,
        command: `nusuk ${argv.join(" ")}`,
      });
    });
  });
}

async function handleCmd(body) {
  const argv = parseCmdRequest(body);
  if (!argv || argv.length === 0) {
    throw new Error("Request body must include 'command' or 'argv'. See /cmd/list for available commands.");
  }

  const cmdStr = argv.join(" ");
  const baseCmd = argv[0];
  if (!CMD_CATALOG[baseCmd]) {
    const available = Object.keys(CMD_CATALOG).join(", ");
    throw new Error(`Unknown command: "${baseCmd}". Available: ${available}`);
  }

  // --- In-process handlers for captcha commands (safe over HTTP) ---
  if (baseCmd === "captcha-watch") {
    const opts = parseCaptchaWatchArgs(argv.slice(1), body);
    const result = await captchaWatchBounded(opts);
    return { ok: true, command: cmdStr, ...result };
  }
  if (baseCmd === "captcha-start") {
    const opts = parseCaptchaStartArgs(argv.slice(1), body);
    const status = await captchaTaskStart(opts);
    return { ok: true, command: cmdStr, status };
  }
  if (baseCmd === "captcha-status") {
    return { ok: true, command: cmdStr, status: captchaTaskStatus() };
  }
  if (baseCmd === "captcha-stop") {
    return { ok: true, command: cmdStr, status: captchaTaskStop() };
  }

  const timeout = Math.min(Number(body.timeout) || 30_000, 300_000);
  const result = await runCliCommand(argv, { timeout });
  return {
    ok: result.ok,
    command: result.command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function handleCmdList() {
  const commands = Object.entries(CMD_CATALOG).map(([name, info]) => ({
    name,
    description: info.description,
    allowedArgs: info.args,
  }));
  return { ok: true, commands, blocked: [] };
}

// ---------------------------------------------------------------------------
// API documentation
// ---------------------------------------------------------------------------

const API_DOCS = [
  { method: "GET", path: "/help", description: "Show this API documentation", auth: false },
  { method: "GET", path: "/", description: "Health check — returns service name and status", auth: false },
  { method: "GET", path: "/health", description: "Health check — returns { ok: true }", auth: false },
  {
    method: "POST", path: "/pull",
    description: "Pull fresh auth, captcha, and entity context from the autha-worker. Saves to auth.json, captcha.json, entity.json.",
    auth: "WORKER_API_TOKEN",
    body: { activeEntityId: "string (optional)", systemUserId: "string (optional)", refresh: "boolean (optional, default false)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/pull -H "Content-Type: application/json" -d \'{"refresh": true}\'',
    response: { ok: true, context: "{ ... }", saved: { auth: true, captcha: true, entityId: "525513", systemUserId: "rhsalisu" } },
  },
  {
    method: "POST", path: "/info",
    description: "Fetch dashboard company info from Nusuk API",
    auth: "auth.json (run /pull first)",
    body: { authToken: "string (optional)", activeEntityId: "string (optional)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/info -H "Content-Type: application/json" -d \'{}\'',
    response: { ok: true, status: 200, data: "{ ...company info }" },
  },
  {
    method: "POST", path: "/send",
    description: "Send a visa request for a group",
    auth: "auth.json + captcha.json (run /pull first)",
    body: { groupId: "string (required)", payload: "object (optional)", captchaToken: "string (optional)", captchaType: "string (optional, default: visa)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/send -H "Content-Type: application/json" -d \'{"groupId": "12345"}\'',
    response: { ok: true, status: 200, data: "{ ...visa response }", timing: "{ total, ttfb }" },
  },
  {
    method: "POST", path: "/api",
    description: "Run a saved API request from the catalog (see /api-list)",
    auth: "auth.json (run /pull first)",
    body: { name: "string (required)", rawJson: "boolean (optional)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/api -H "Content-Type: application/json" -d \'{"name": "company-info"}\'',
    response: { ok: true, status: 200, data: "{ ...API response }", timing: "{ total, ttfb }" },
  },
  {
    method: "GET", path: "/api-list",
    description: "List all saved API requests in the catalog",
    auth: false,
    example: "curl https://toque.decloud.workers.dev/api-list",
    response: { ok: true, requests: "[{ name, path, method, captcha, payload }]" },
  },
  {
    method: "POST", path: "/request",
    description: "Send a custom API request to any Nusuk endpoint path",
    auth: "auth.json (run /pull first)",
    body: { path: "string (required)", method: "string (optional, default: GET)", payload: "object (optional)", headers: "object (optional)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/request -H "Content-Type: application/json" -d \'{"path": "/umrah/reports_apis/api/Dashboard/DashboardCompanyInfo", "method": "POST", "payload": {}}\'',
    response: { ok: true, status: 200, data: "{ ...response }", timing: "{ total, ttfb }" },
  },
  {
    method: "POST", path: "/groups",
    description: "List groups with pagination",
    auth: "auth.json (run /pull first)",
    body: { limit: "number (optional, default 10)", offset: "number (optional, default 0)", raw: "boolean (optional)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/groups -H "Content-Type: application/json" -d \'{"limit": 10}\'',
    response: { ok: true, status: 200, groups: "[{ id, name }]", raw: "(if raw=true)" },
  },
  {
    method: "POST", path: "/login",
    description: "Auto-login to Nusuk: solves a CAPTCHA, encrypts credentials (AES-128-CBC), sends /eh/public/authentication/login, saves JWT to auth.json",
    auth: "CAPMONSTER_API_KEY or CAPSOLVER_API_KEY env var",
    body: { username: "string (required — login email)", password: "string (required — login password)", provider: "string (optional: capmonster|capsolver, default: capmonster)", xChannel: "string (optional)", trustedDeviceToken: "string (optional)", siteKey: "string (optional)", pageUrl: "string (optional)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/login -H "Content-Type: application/json" -d \'{"username":"user@email.com","password":"pass123","provider":"capmonster"}\'',
    response: { ok: true, status: 200, data: "{ ...login response }", captchaToken: "solved-captcha", saved: true, timing: "{ total, ttfb }" },
  },
  {
    method: "POST", path: "/verify-login",
    description: "Verify OTP after auto-login. Sends authentication/verifyLogin with the transactionId and OTP code, saves the final JWT to auth.json.",
    auth: "none (uses browser session from /login)",
    body: { transactionId: "string (required — from /login response)", otpCode: "string (required — 4-digit OTP sent to email/phone)", system: "string (optional, default: 1)", module: "string (optional, default: 1)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/verify-login -H "Content-Type: application/json" -d \'{"transactionId":"abc-123","otpCode":"1234"}\'',
    response: { ok: true, status: 200, data: "{ ...verify response with authInfo.userToken }", saved: true, timing: "{ total, ttfb }" },
  },
  {
    method: "POST", path: "/refresh-token",
    description: "Refresh the JWT using the stored refresh token from auth.json. Falls back to a full re-login using the saved profile.json if no refresh token is available.",
    auth: "none (uses stored refresh token or saved profile)",
    body: {},
    example: 'curl -X POST https://toque.decloud.workers.dev/refresh-token -H "Content-Type: application/json" -d \'{}\'',
    response: { ok: true, status: 200, data: "{ ...refresh response }", saved: true, method: "refreshToken", timing: "{ total, ttfb }" },
  },
  {
    method: "POST", path: "/captcha/solve",
    description: "Solve a CAPTCHA via CapSolver (default) or CapMonster Cloud (--capmonster)",
    auth: "CAPSOLVER_API_KEY or CAPMONSTER_API_KEY env var",
    body: { provider: "string (optional: capsolver|capmonster)", version: "number (optional: 2|3, default 2)", captchaType: "string (optional: recaptcha|turnstile|visa|login|general)", enterprise: "boolean (optional)", siteKey: "string (optional)", pageUrl: "string (optional)", pageAction: "string (optional)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/captcha/solve -H "Content-Type: application/json" -d \'{"provider":"capmonster","version":2}\'',
    response: { ok: true, token: "captcha-token-string", provider: "capmonster" },
  },
  {
    method: "POST", path: "/captcha/balance",
    description: "Check captcha solver account balance (CapSolver or CapMonster Cloud)",
    auth: "CAPSOLVER_API_KEY or CAPMONSTER_API_KEY env var",
    body: { provider: "string (optional: capsolver|capmonster)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/captcha/balance -H "Content-Type: application/json" -d \'{"provider":"capmonster"}\'',
    response: { ok: true, balance: 1.50, provider: "capmonster" },
  },
  {
    method: "POST", path: "/schedule",
    description: "Schedule a timed visa request (blocks until target time). For durable scheduling use /schedule/workflow instead.",
    auth: "auth.json + captcha.json (run /pull first)",
    body: { target: "string (required — HH:MM:SS[.mmm])", groupId: "string (required)", payload: "object (optional)", captchaType: "string (optional, default: visa)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/schedule -H "Content-Type: application/json" -d \'{"target": "21:00:00.500", "groupId": "12345"}\'',
    response: { ok: true, status: 200, data: "{ ...visa response }", scheduledAt: "ISO", firedAt: "ISO" },
  },
  {
    method: "POST", path: "/schedule/workflow",
    description: "Create a durable Cloudflare Workflow instance for scheduled visa send. Survives container sleep/restart.",
    auth: "none (runs in Worker runtime)",
    body: { targetTime: "string (required)", groupId: "string (required)", captcha: "boolean (optional, default true)", captchaType: "string (optional, default: visa)", payload: "object (optional)", pullBefore: "boolean (optional, default true)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/schedule/workflow -H "Content-Type: application/json" -d \'{"targetTime": "21:00:00:000", "groupId": "12345", "captcha": true}\'',
    response: { ok: true, instanceId: "abc-123", targetTime: "ISO", groupId: "12345" },
  },
  {
    method: "GET", path: "/schedule/workflow/status",
    description: "Check the status of a Workflow instance",
    auth: "none",
    params: { instanceId: "string (required)" },
    example: "curl 'https://toque.decloud.workers.dev/schedule/workflow/status?instanceId=abc-123'",
    response: { ok: true, instanceId: "abc-123", status: "{ status, steps, ... }" },
  },
  {
    method: "POST", path: "/schedule/workflow/terminate",
    description: "Terminate a running Workflow instance",
    auth: "none",
    body: { instanceId: "string (required)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/schedule/workflow/terminate -H "Content-Type: application/json" -d \'{"instanceId": "abc-123"}\'',
    response: { ok: true, instanceId: "abc-123", terminated: true },
  },
  {
    method: "POST", path: "/cmd",
    description: "Run any CLI command as a subprocess. See /cmd/list for available commands.",
    auth: "varies by command",
    body: { command: "string (required)", args: "string[] (optional)", argv: "string[] (alternative)", timeout: "number (optional, default 30000, max 300000)" },
    example: 'curl -X POST https://toque.decloud.workers.dev/cmd -H "Content-Type: application/json" -d \'{"command": "bench", "args": ["15"]}\'',
    response: { ok: true, command: "nusuk bench 15", exitCode: 0, stdout: "...", stderr: "" },
  },
  {
    method: "GET", path: "/cmd/list",
    description: "List all available CLI commands exposed via /cmd",
    auth: false,
    example: "curl https://toque.decloud.workers.dev/cmd/list",
    response: { ok: true, commands: "[{ name, description, allowedArgs }]", blocked: "[]" },
  },
];

function handleHelp() {
  return { ok: true, service: "toque-container", version: "1.0.0", endpoints: API_DOCS };
}

// ---------------------------------------------------------------------------
// Router & server
// ---------------------------------------------------------------------------

const ROUTES = {
  "/": handleHelp,
  "/help": handleHelp,
  "/health": async () => ({ ok: true }),
  "/pull": handlePull,
  "/info": handleInfo,
  "/send": handleSend,
  "/api": handleApi,
  "/request": handleRequest,
  "/groups": handleGroups,
  "/login": handleAutoLogin,
  "/verify-login": handleVerifyLogin,
  "/refresh-token": handleRefreshToken,
  "/captcha/solve": handleCaptchaSolve,
  "/captcha/balance": handleCaptchaBalance,
  "/schedule": handleSchedule,
  "/schedule/workflow": handleSchedule,
  "/api-list": handleListApis,
  "/cmd": handleCmd,
  "/cmd/list": handleCmdList,
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = ROUTES[url.pathname];

  if (!handler) {
    return jsonResponse(res, 404, { ok: false, error: `Unknown route: ${url.pathname}` }, req);
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse(res, 405, { ok: false, error: "Method not allowed" }, req);
  }

  const startedAt = Date.now();
  try {
    const body = req.method === "POST" ? await parseBody(req) : {};
    const result = await handler(body);
    const status = result.status && !result.ok ? result.status : 200;
    jsonResponse(res, status, result, req);
    log.info("request.handled", `${req.method} ${url.pathname}`, {
      method: req.method,
      path: url.pathname,
      status,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    log.error("request.failed", `${req.method} ${url.pathname} failed`, {
      method: req.method,
      path: url.pathname,
      error: err.message,
      durationMs: Date.now() - startedAt,
    });
    jsonResponse(res, 500, { ok: false, error: err.message }, req);
  }
});

server.listen(PORT, () => {
  log.info("server.listening", `Toque container listening on port ${PORT}`, { port: PORT });
});
