#!/usr/bin/env node

import "dotenv/config";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Nusuk } from "../src/nusuk.js";
import { AuthaWorker } from "../src/worker.js";
import { parseJwt } from "../src/jwt.js";
import { CapSolver } from "../src/capsolver.js";
import { CapMonsterSolver } from "../src/capmonster.js";
import { parsePositiveCount, parseTargetTime } from "../src/validation.js";
import { computeSendSchedule } from "../src/scheduling.js";
import { buildVisaPayload } from "../src/visa-payload.js";
import { buildLoginRequest, DEFAULT_TRUSTED_DEVICE_TOKEN } from "../src/nusuk-crypto.js";
import { summarizeRequestTiming } from "../src/timing.js";
import { writePrivateJson, ms, formatTime } from "../src/utils.js";
import {
  isProcessRunning,
  normalizeCaptchaType,
  parseInterval,
  pullCaptchaOnce,
  readPidFile,
  runCaptchaPullLoop,
} from "../src/captcha-puller.js";
import { getRequest, listRequests } from "../src/requests.js";
import { extractGroups, formatGroups, normalizeGroupId, parseGroupSelection } from "../src/groups.js";

function formatCurlPreview(url, headers, payload) {
  const lines = [];
  lines.push(`curl --request POST --url '${url}'`);
  for (const [key, value] of Object.entries(headers)) {
    const safeValue = String(value).replace(/'/g, "'\\''");
    lines.push(`  -H '${key.toLowerCase()}: ${safeValue}'`);
  }
  if (payload !== undefined && payload !== null) {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const safeBody = body.replace(/'/g, "'\\''");
    lines.push(`  --data-raw '${safeBody}'`);
  }
  return lines.join("\\n");
}

function canPrompt() {
  return Boolean(input.isTTY && output.isTTY);
}

async function ask(question) {
  if (!canPrompt()) return null;
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function hasCaptchaToken(data) {
  return Boolean(
    data?.captchaToken || data?.visa || data?.login || data?.general
  );
}

function findAuth() {
  const candidates = [
    process.env.AUTH_PATH,
    "auth.json",
    resolve(process.cwd(), "auth.json"),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, "utf8"));
        if (parseJwt(data?.response?.data?.authInfo?.userToken)) return p;
      } catch {}
    }
  }
  return null;
}

function findCaptcha() {
  const candidates = [
    process.env.CAPTCHA_PATH,
    "captcha.json",
    resolve(process.cwd(), "captcha.json"),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, "utf8"));
        if (hasCaptchaToken(data)) return p;
      } catch {}
    }
  }
  return null;
}

function readCaptchaToken(type = "visa") {
  const p = findCaptcha();
  if (!p) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return (
      data[type] ||
      data.captchaToken ||
      data.visa ||
      data.login ||
      data.general ||
      null
    );
  } catch {
    return null;
  }
}

function parsePayloadOptions(args, { defaultCaptchaType = "visa" } = {}) {
  const dataIdx = args.indexOf("--data");
  const dataRawIdx = args.indexOf("--data-raw");
  const dataStr = dataIdx !== -1 ? args[dataIdx + 1] : null;
  const dataRawStr = dataRawIdx !== -1 ? args[dataRawIdx + 1] : null;
  let payload = undefined;
  if (dataStr !== null) {
    try {
      payload = JSON.parse(dataStr);
    } catch {
      payload = dataStr;
    }
  } else if (dataRawStr !== null) {
    try {
      payload = JSON.parse(dataRawStr);
    } catch {
      payload = dataRawStr;
    }
  }
  const captchaTypeIndex = args.indexOf("--captcha-type");
  const captchaType = captchaTypeIndex !== -1 ? args[captchaTypeIndex + 1] : defaultCaptchaType;
  const useCaptcha = args.includes("--captcha");
  return { payload, captchaType, useCaptcha };
}

function injectCaptchaToken(payload, captchaToken) {
  if (!captchaToken) return payload;
  if (payload === undefined || payload === null) {
    return { captchaToken, recaptchaToken: captchaToken };
  }
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      console.warn(
        "Warning: --data payload is not valid JSON; captcha token cannot be injected automatically"
      );
      return payload;
    }
  }
  return typeof payload === "object"
    ? {
        ...payload,
        captchaToken: payload?.captchaToken || captchaToken,
        recaptchaToken: payload?.recaptchaToken || captchaToken,
      }
    : payload;
}

function writeAuthToken(token, entityId) {
  const authPath = process.env.AUTH_PATH || "auth.json";
  // Merge with existing auth.json instead of overwriting it — preserves
  // refreshToken, permsToken, and entityId from previous logins.
  let existing = {};
  try { existing = JSON.parse(readFileSync(authPath, "utf8")); } catch { /* ignore */ }
  existing.response = existing.response || { data: { authInfo: {} } };
  existing.response.data = existing.response.data || { authInfo: {} };
  existing.response.data.authInfo = existing.response.data.authInfo || {};
  existing.response.data.authInfo.userToken = token;
  if (entityId) existing.response.data.authInfo.entityId = String(entityId);
  writePrivateJson(authPath, existing);
}

function ensureInitFiles() {
  const created = [];
  const files = ["auth.json", "captcha.json", "entity.json"];
  for (const file of files) {
    if (!existsSync(file)) {
      writePrivateJson(file, {});
      created.push(file);
    }
  }

  if (!existsSync(".env")) {
    if (existsSync(".env.example")) {
      copyFileSync(".env.example", ".env");
    } else {
      writeFileSync(".env", "", { mode: 0o600 });
    }
    created.push(".env");
  }

  return created;
}

function clearLocalState() {
  const files = [
    process.env.AUTH_PATH || "auth.json",
    process.env.CAPTCHA_PATH || "captcha.json",
    process.env.ENTITY_CONFIG_PATH || "entity.json",
    process.env.PROFILE_PATH || "profile.json",
  ];

  for (const path of files) {
    if (!path) continue;
    try {
      writePrivateJson(path, {});
    } catch {
      try {
        writeFileSync(path, "{}\n", { mode: 0o600 });
      } catch {}
    }
  }

  return files;
}

async function cmdInit(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: nusuk init

Creates ignored local configuration files after cloning the repository.
`);
    return;
  }

  const created = ensureInitFiles();
  if (created.length === 0) {
    console.log("All local ignored files already exist.");
    return;
  }
  for (const file of created) {
    console.log(`Created ${file}`);
  }
}

function runCommandSync(command, args = []) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function getTimeSource() {
  return process.env.TIME_SYNC_SOURCE || "https://worldtimeapi.org/api/timezone/Etc/UTC";
}

function formatTimeSpan(msValue) {
  return `${msValue >= 0 ? "+" : ""}${msValue}ms`;
}

function isFileSource(source) {
  if (source.startsWith("file://")) return true;
  return existsSync(source);
}

function fetchWithTool(source) {
  const candidates = [
    { command: "curl", args: ["-fsL", source] },
    { command: "wget", args: ["-qO-", source] },
  ];

  for (const { command, args } of candidates) {
    const result = runCommandSync(command, args);
    if (result.status === 0 && result.stdout) {
      return result.stdout;
    }
  }

  throw new Error("No available HTTP fetch tool found (curl or wget) or all fetch attempts failed.");
}

async function fetchNetworkTime(source) {
  if (isFileSource(source)) {
    let sourcePath = source;
    if (source.startsWith("file://")) {
      sourcePath = fileURLToPath(source);
    }
    const raw = readFileSync(sourcePath, "utf8");
    const data = JSON.parse(raw);
    const remoteIso = data.utc_datetime || data.datetime || data.utcDateTime || data.currentDateTime || null;
    if (!remoteIso) {
      throw new Error("Time source file returned an unsupported payload");
    }
    const networkTime = new Date(remoteIso);
    if (Number.isNaN(networkTime.getTime())) {
      throw new Error("Time source file returned an invalid timestamp");
    }
    return networkTime;
  }

  let body;
  try {
    const response = await fetch(source, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Time source returned ${response.status} ${response.statusText}`);
    }
    body = await response.text();
  } catch (error) {
    body = fetchWithTool(source);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new Error(`Failed to parse time source response: ${error.message}`);
  }

  const remoteIso = data.utc_datetime || data.datetime || data.utcDateTime || data.currentDateTime || null;
  if (!remoteIso) {
    throw new Error("Time source returned an unsupported payload");
  }

  const networkTime = new Date(remoteIso);
  if (Number.isNaN(networkTime.getTime())) {
    throw new Error("Time source returned an invalid timestamp");
  }
  return networkTime;
}

async function cmdSyncTime(args) {
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: nusuk sync-time [--dry-run] [--source <url>]\n\nOptions:\n  --dry-run            Show network time and offset without changing system clock\n  --source <url>       Use a custom time source URL (default: ${getTimeSource()})\n`);
    return;
  }

  const source = getArg("--source") || getTimeSource();
  const dryRun = args.includes("--dry-run");
  const pool = "pool.ntp.org";

  if (dryRun) {
    const networkTime = await fetchNetworkTime(source);
    const localTime = new Date();
    const offsetMs = networkTime.getTime() - localTime.getTime();
    console.log(`Network time: ${networkTime.toISOString()}`);
    console.log(`Local time  : ${localTime.toISOString()}`);
    console.log(`Clock offset: ${formatTimeSpan(offsetMs)}`);
    console.log("Dry run complete. No system clock changes were made.");
    return;
  }

  if (process.platform === "win32") {
    console.error("Automatic time synchronization is not supported on Windows by this CLI.");
    process.exitCode = 1;
    return;
  }

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    console.error("Root privileges are required to set the system clock. Re-run as root or with sudo.");
    process.exitCode = 1;
    return;
  }

  if (process.platform === "linux") {
    let result = runCommandSync("timedatectl", ["set-ntp", "true"]);
    if (result.status === 0) {
      console.log("Enabled timedatectl NTP sync.");
      return;
    }

    result = runCommandSync("ntpdate", ["-u", pool]);
    if (result.status === 0) {
      console.log(result.stdout.trim() || "System time synchronized via ntpdate.");
      return;
    }

    let networkTime;
    try {
      networkTime = await fetchNetworkTime(source);
    } catch (error) {
      console.error(error.message);
      console.error("Unable to update clock via timedatectl or ntpdate.");
      process.exitCode = 1;
      return;
    }

    result = runCommandSync("date", ["-s", networkTime.toISOString()]);
    if (result.status === 0) {
      console.log("System clock updated using date.");
      return;
    }
    console.error("Unable to adjust system clock. Ensure timedatectl or ntpdate is installed and try again.");
    process.exitCode = 1;
    return;
  }

  if (process.platform === "darwin") {
    let result = runCommandSync("sntp", ["-sS", pool]);
    if (result.status === 0) {
      console.log(result.stdout.trim() || "System time synchronized via sntp.");
      return;
    }

    let networkTime;
    try {
      networkTime = await fetchNetworkTime(source);
    } catch (error) {
      console.error(error.message);
      console.error("Unable to update clock via sntp.");
      process.exitCode = 1;
      return;
    }

    const dateArg = networkTime.toISOString().replace(/T/, " ").replace(/Z$/, "");
    result = runCommandSync("date", ["-u", dateArg]);
    if (result.status === 0) {
      console.log("System clock updated using date.");
      return;
    }
    console.error("Unable to adjust system clock. Ensure sntp is installed and try again.");
    process.exitCode = 1;
    return;
  }

  console.error(`Automatic time sync is not implemented for platform: ${process.platform}`);
  process.exitCode = 1;
}

function writeCaptchaToken(token, type = "visa") {
  const captchaPath = process.env.CAPTCHA_PATH || "captcha.json";
  const existing = existsSync(captchaPath)
    ? JSON.parse(readFileSync(captchaPath, "utf8"))
    : {};
  existing[type] = token;
  existing.captchaToken = token;
  existing.entityId = existing.entityId || process.env.ACTIVE_ENTITY_ID || readEntityId();
  existing.updatedAt = new Date().toISOString();
  writePrivateJson(captchaPath, existing);
}

function readEntityId() {
  const filePath = process.env.ENTITY_CONFIG_PATH || "entity.json";
  try {
    return JSON.parse(readFileSync(filePath, "utf8")).activeEntityId || null;
  } catch {
    return null;
  }
}

function readStoredGroupId() {
  const filePath = process.env.ENTITY_CONFIG_PATH || "entity.json";
  try {
    return JSON.parse(readFileSync(filePath, "utf8")).groupId || null;
  } catch {
    return null;
  }
}

function writeStoredGroupId(groupId) {
  const entityPath = process.env.ENTITY_CONFIG_PATH || "entity.json";
  const existing = existsSync(entityPath)
    ? JSON.parse(readFileSync(entityPath, "utf8"))
    : {};
  writePrivateJson(entityPath, {
    ...existing,
    groupId: String(groupId),
  });
}

async function pullCreds({ entityId, type = "visa", endpoint, quiet = false } = {}) {
  entityId = entityId || process.env.ACTIVE_ENTITY_ID || readEntityId();

  const worker = new AuthaWorker({ endpoint, entityId });
  if (!quiet) {
    console.log(`Pulling from ${worker.endpoint} (entity ${entityId}, system user ${worker.systemUserId}, captcha type ${type})...\n`);
  }

  const context = await worker.fetchContext(entityId, { refresh: true });
  return saveContext(context, { type, worker, quiet });
}

function saveContext(context, { type = "visa", worker, quiet = false } = {}) {
  const entityId = context.entityId || context.entity?.entityId;
  const token = worker.extractToken(context.auth);
  const captchaOptions = context.captcha || {};
  const captchaOrder = type === "login"
    ? [captchaOptions.login, captchaOptions.latest, captchaOptions.visa]
    : type === "general"
      ? [captchaOptions.latest, captchaOptions.visa, captchaOptions.login]
      : [captchaOptions.visa, captchaOptions.latest, captchaOptions.login];
  const captcha = captchaOrder.find((entry) => entry?.captchaToken)?.captchaToken || null;
  const authPath = process.env.AUTH_PATH || "auth.json";
  const captchaPath = process.env.CAPTCHA_PATH || "captcha.json";
  const entityPath = process.env.ENTITY_CONFIG_PATH || "entity.json";

  if (token) {
    // Save refreshToken and permsToken from the D1 context too, so
    // `nusuk refresh-token` works after a pull-based login (not just
    // after a full browser login-auto).
    const auth = context.auth || {};
    const refreshToken = auth.refreshToken || auth.token?.refreshToken;
    const permsToken = auth.permsToken || auth.token?.permsToken;
    writeAuthToken(token, entityId);
    if (refreshToken || permsToken) {
      const authPath = process.env.AUTH_PATH || "auth.json";
      let existing = {};
      try { existing = JSON.parse(readFileSync(authPath, "utf8")); } catch { /* ignore */ }
      existing.response = existing.response || { data: { authInfo: {} } };
      existing.response.data = existing.response.data || { authInfo: {} };
      existing.response.data.authInfo = existing.response.data.authInfo || {};
      if (refreshToken) existing.response.data.authInfo.refreshToken = refreshToken;
      if (permsToken) existing.response.data.authInfo.permsToken = permsToken;
      writePrivateJson(authPath, existing);
    }
  }
  if (captcha) {
    const existingCaptcha = existsSync(captchaPath)
      ? JSON.parse(readFileSync(captchaPath, "utf8"))
      : {};
    existingCaptcha[type] = captcha;
    existingCaptcha.captchaToken = captcha;
    existingCaptcha.entityId = existingCaptcha.entityId || entityId;
    existingCaptcha.updatedAt = new Date().toISOString();
    writePrivateJson(captchaPath, existingCaptcha);
  }

  const capturedEntity = context.entity || {};
  if (capturedEntity.entityId || entityId) {
    const existingEntity = existsSync(entityPath)
      ? JSON.parse(readFileSync(entityPath, "utf8"))
      : {};
    writePrivateJson(entityPath, {
      ...existingEntity,
      activeEntityId: capturedEntity.activeEntityId || capturedEntity.entityId || entityId,
      activeEntityTypeId: capturedEntity.activeEntityTypeId || existingEntity.activeEntityTypeId,
      entityId: capturedEntity.entityId || entityId,
      entityTypeId: capturedEntity.entityTypeId || capturedEntity.activeEntityTypeId || existingEntity.entityTypeId,
      systemUserId: context.systemUserId || worker.systemUserId,
    });
  }

  return { token, captcha, authPath, captchaPath, entityPath, entityId, context };
}

async function cmdLogout(args) {
  const cleared = clearLocalState();
  console.log(`\n✓ Cleared local auth and entity state`);
  console.log(`  files: ${cleared.join(", ")}`);
  return cleared;
}

async function cmdWhoami(args) {
  // Show current entity info extracted from the JWT in auth.json
  const authPath = process.env.AUTH_PATH || "auth.json";
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(authPath, "utf8")); } catch { /* ignore */ }
  const token = parsed?.response?.data?.authInfo?.userToken;
  if (!token) {
    console.log("No auth token found. Run `nusuk login` or `nusuk login-auto` first.");
    process.exitCode = 1;
    return;
  }
  const jwt = parseJwt(token);
  if (!jwt) {
    console.log("Auth token is expired or invalid. Run `nusuk login-auto` to get a fresh token.");
    process.exitCode = 1;
    return;
  }
  const p = jwt.payload;
  const authInfo = parsed?.response?.data?.authInfo || {};
  const entityId = authInfo.entityId || p.defaultEntityId || p.entities?.[0]?.entityId;
  const entityTypeId = authInfo.entityTypeId || p.defaultEntityTypeId || p.entities?.[0]?.entityTypeId;
  const tokenTypeMap = { 2: "TEMP", 3: "AUTH", 4: "REFRESH", 5: "USER" };
  const tokenTypeLabel = tokenTypeMap[p.tokenType] || p.tokenType;

  console.log(`\n┌─ Current session`);
  console.log(`│  user        ${p.sub || "unknown"}`);
  console.log(`│  name        ${p.name || p.nameAr || "unknown"}`);
  console.log(`│  userId      ${p.userId || p.userIdStr || "unknown"}`);
  console.log(`│  userType    ${p.userType ?? "unknown"}`);
  console.log(`│  tokenType   ${tokenTypeLabel}${p.tokenType === 3 ? " (has entity claims)" : p.tokenType === 5 ? " (no entity claims — run verify-login)" : ""}`);
  console.log(`│  entityId    ${entityId || "none"}`);
  console.log(`│  entityType  ${entityTypeId || "none"}`);
  if (p.entities?.length) {
    console.log(`│  entities    ${p.entities.length} available:`);
    for (const e of p.entities) {
      console.log(`│    • ${e.entityId} (type ${e.entityTypeId})${e.entityNameAr ? ` ${e.entityNameAr}` : ""}${e.entityNameEn ? ` ${e.entityNameEn}` : ""}${e.activeEntityFlag ? " [active]" : ""}`);
    }
  }
  console.log(`│  issued      ${new Date(p.iat * 1000).toISOString()}`);
  console.log(`│  expires     ${new Date(p.exp * 1000).toISOString()}`);
  console.log(`│  remaining   ${Math.round((p.exp * 1000 - Date.now()) / 60000)} min`);
  console.log(`└─`);
}

async function cmdLogin(args) {
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  let systemUserId = getArg("--system-user") || process.env.SYSTEM_USER_ID || "";
  if (!systemUserId) {
    systemUserId = await ask("System user ID: ") || "";
  }
  if (!systemUserId) {
    throw new Error("System user ID is required. Pass --system-user <id> or set SYSTEM_USER_ID");
  }

  const worker = new AuthaWorker({
    endpoint: getArg("--endpoint"),
    systemUserId,
  });
  console.log(`\n→ Loading D1 context for system user ${systemUserId}...`);
  const context = await worker.fetchUserContext(systemUserId);
  const result = saveContext(context, {
    type: getArg("--type") || "visa",
    worker,
  });

  console.log(`\n┌─ Login result`);
  console.log(`│  ${result.token ? "✓" : "✗"} auth    ${result.token ? "valid JWT saved" : "not available"}`);
  console.log(`│  ${result.captcha ? "✓" : "✗"} captcha ${result.captcha ? "saved" : "not available"}`);
  console.log(`│  • entity  ${context.entityId}`);
  console.log(`│  • files   ${result.authPath}, ${result.captchaPath}, ${result.entityPath}`);
  console.log(`└─`);
  if (!result.token) process.exitCode = 1;
}

async function cmdAutoLogin(args) {
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const provider = args.includes("--capmonster") ? "capmonster" : (getArg("--provider") || process.env.CAPTCHA_PROVIDER || "capmonster");
  const siteKey = getArg("--site-key") || process.env.CAPTCHA_SITE_KEY || process.env.CAPMONSTER_SITE_KEY || "6Le-3OwpAAAAAARztuPscqBNbpEY3okMkd7dCoyx";
  const pageUrl = getArg("--page-url") || process.env.CAPTCHA_PAGE_URL || "https://masar.nusuk.sa/pub/login";
  const xChannel = getArg("--x-channel") || process.env.X_CHANNEL || "ZlEW8G0jE195d1hY+hvN6/0T9KljTFeVg798I3V1t6I=";
  const trustedDeviceToken = getArg("--trusted-device-token") || process.env.TRUSTED_DEVICE_TOKEN || DEFAULT_TRUSTED_DEVICE_TOKEN;
  const username = getArg("--username") || getArg("--user") || process.env.NUSUK_USERNAME;
  const password = getArg("--password") || getArg("--pass") || process.env.NUSUK_PASSWORD;
  const aesKey = getArg("--aes-key") || process.env.NUSUK_AES_KEY;
  const captchaVersion = Number(getArg("--captcha-version") || 2);
  const captchaType = getArg("--captcha-type") || "recaptcha";
  const enterprise = args.includes("--enterprise");

  if (!username || !password) {
    throw new Error("Username and password are required. Pass --username <email> --password <pass> or set NUSUK_USERNAME/NUSUK_PASSWORD env vars");
  }

  console.log(`Auto-login via ${provider}...`);
  console.log(`  site key : ${siteKey}`);
  console.log(`  page url : ${pageUrl}`);
  console.log(`  username : ${username}`);

  // Step 1: Solve the captcha
  let captchaToken;
  if (provider === "capmonster") {
    const solver = new CapMonsterSolver({
      clientKey: process.env.CAPMONSTER_API_KEY,
      siteKey,
      pageUrl,
      pageAction: getArg("--page-action") || process.env.CAPMONSTER_PAGE_ACTION,
    });
    console.log("  solving captcha via CapMonster Cloud...");
    captchaToken = await solver.solve({
      version: captchaVersion,
      type: captchaType,
      enterprise,
      timeout: 180000,
    });
  } else {
    if (!process.env.CAPSOLVER_API_KEY) throw new Error("CAPSOLVER_API_KEY is required");
    const solver = new CapSolver({
      clientKey: process.env.CAPSOLVER_API_KEY,
      siteKey,
      pageUrl,
      pageAction: getArg("--page-action") || process.env.CAPSOLVER_PAGE_ACTION,
    });
    console.log("  solving captcha via CapSolver...");
    captchaToken = await solver.solve();
  }
  console.log(`  captcha  : ${captchaToken.slice(0, 40)}...`);

  // Step 2: Build login payload and headers using Nusuk's encryption
  const { payload: loginPayload, headers: loginHeaders } = buildLoginRequest({
    username,
    password,
    captchaToken,
    key: aesKey,
    xChannel,
    trustedDeviceToken,
  });
  console.log(`  otp      : ${loginPayload.otpTimeStamp.slice(0, 30)}...`);
  console.log(`  auth     : ${loginHeaders.authorization.slice(0, 30)}...`);

  // Step 3: Send the login request (skip auth — no JWT yet)
  console.log("  sending login request...");
  const nusuk = new Nusuk({
    referer: "https://masar.nusuk.sa/pub/login",
  });
  await nusuk.init();
  try {
    const res = await nusuk.request("/eh/public/authentication/login", {
      method: "POST",
      payload: loginPayload,
      headers: loginHeaders,
    });
    console.log(`  status   : ${res.status}`);
    if (res.timing) console.log(`  timing   :`, res.timing);

    // Step 4: Save the JWT token if login succeeded
    // The login response has two paths:
    //   - trustedDevice=true:  response.data.authInfo.{token,userToken,refreshToken,permsToken}
    //     → userToken is the AUTH_TOKEN (type 3) with entity claims — save it.
    //   - trustedDevice=false: response.data.token is a TEMP_TOKEN (type 2),
    //     authInfo is null, OTP is required.
    //     → Do NOT save the temp token as userToken — it lacks entity claims
    //       and will cause all authenticated requests to fail. Only save it
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
      let existing = {};
      try { existing = JSON.parse(readFileSync(authPath, "utf8")); } catch { /* ignore */ }
      existing.response = existing.response || { data: { authInfo: {} } };
      existing.response.data = existing.response.data || { authInfo: {} };
      existing.response.data.authInfo = existing.response.data.authInfo || {};
      existing.response.data.authInfo.userToken = token;
      // Save all tokens from the response for completeness
      if (authInfo?.refreshToken) existing.response.data.authInfo.refreshToken = authInfo.refreshToken;
      if (authInfo?.permsToken) existing.response.data.authInfo.permsToken = authInfo.permsToken;
      if (authInfo?.token) existing.response.data.authInfo.token = authInfo.token;
      // Extract entity from JWT claims (authInfo.entityId is null in login response)
      const jwt = parseJwt(token);
      const entityId = authInfo?.entityId || jwt?.payload?.defaultEntityId || jwt?.payload?.entities?.[0]?.entityId;
      const entityTypeId = authInfo?.entityTypeId || jwt?.payload?.defaultEntityTypeId || jwt?.payload?.entities?.[0]?.entityTypeId;
      if (entityId) existing.response.data.authInfo.entityId = entityId;
      if (entityTypeId) existing.response.data.authInfo.entityTypeId = entityTypeId;
      writePrivateJson(authPath, existing);
      console.log(`  auth     : valid JWT saved to ${authPath}`);
      if (entityId) console.log(`  entity   : ${entityId}${entityTypeId ? ` (type ${entityTypeId})` : ""}`);
    } else if (otpRequired) {
      // trustedDevice=false: don't save the temp token to auth.json.
      // Store it as intermediateToken in profile.json for verify-login.
      console.log(`  auth     : OTP required (temp token not saved to auth.json)`);
      console.log(`  otp      : required — run \`nusuk verify-login --transaction-id ${transactionId} --otp <code>\``);
    } else {
      console.log(`  auth     : no token in response`);
      process.exitCode = 1;
    }

    // Step 5: Save the login profile for later token refresh
    // Stores the input credentials and config so `nusuk refresh-token` can
    // re-authenticate or refresh without re-entering anything.
    const profilePath = process.env.PROFILE_PATH || "profile.json";
    const profile = {
      username,
      password,
      aesKey: aesKey || undefined,
      xChannel: xChannel || undefined,
      trustedDeviceToken: trustedDeviceToken || undefined,
      captcha: { provider, siteKey, pageUrl, captchaVersion, captchaType, enterprise },
      lastLoginAt: new Date().toISOString(),
      lastLoginStatus: token ? "ok" : "failed",
      trustedDevice: trustedDevice ?? null,
      transactionId: res.json?.response?.data?.transactionId || null,
    };
    writePrivateJson(profilePath, profile);
    console.log(`  profile  : saved to ${profilePath}`);

    if (res.json) console.log(`  body     :`, JSON.stringify(res.json, null, 2));
    else console.log(`  body     :`, res.body);
  } finally {
    await nusuk.close();
  }
}

async function cmdVerifyLogin(args) {
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const transactionId = getArg("--transaction-id") || getArg("--transaction");
  const otpCode = getArg("--otp") || getArg("--code");
  const system = getArg("--system") || "1";
  const module = getArg("--module") || "1";

  if (!transactionId) throw new Error("Transaction ID is required. Pass --transaction-id <id> (from login-auto response)");
  if (!otpCode) throw new Error("OTP code is required. Pass --otp <4-digit-code>");

  console.log(`Verifying OTP...`);
  console.log(`  transaction : ${transactionId}`);
  console.log(`  otp code    : ${otpCode}`);

  // Load the AES key from profile.json (saved by login-auto) so the
  // otpTimeStamp uses the same key as the original login request.
  let aesKey;
  try {
    const profilePath = process.env.PROFILE_PATH || "profile.json";
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    aesKey = profile.aesKey || undefined;
  } catch { /* profile doesn't exist — fall back to default key */ }

  const { buildOtpTimeStamp } = await import("../src/nusuk-crypto.js");
  const verifyPayload = {
    transactionId,
    system,
    module,
    otpCode,
    otpTimeStamp: buildOtpTimeStamp(aesKey),
  };

  const nusuk = new Nusuk({ referer: "https://masar.nusuk.sa/pub/login" });
  await nusuk.init();
  try {
    const res = await nusuk.request("/eh/public/authentication/verifyLogin", {
      method: "POST",
      payload: verifyPayload,
    });
    console.log(`  status      : ${res.status}`);
    if (res.timing) console.log(`  timing      :`, res.timing);

    // The verifyLogin response has the full AUTH_TOKEN with entity claims.
    // Response structure: response.data.{token, userToken, refreshToken, permsToken}
    // or response.data.authInfo.{userToken, refreshToken, permsToken}
    const data = res.json?.response?.data;
    const authInfo = data?.authInfo || data;
    const token = authInfo?.userToken || authInfo?.token || data?.token;
    if (token) {
      const authPath = process.env.AUTH_PATH || "auth.json";
      let existing = {};
      try { existing = JSON.parse(readFileSync(authPath, "utf8")); } catch { /* ignore */ }
      existing.response = existing.response || { data: { authInfo: {} } };
      existing.response.data = existing.response.data || { authInfo: {} };
      existing.response.data.authInfo = existing.response.data.authInfo || {};
      existing.response.data.authInfo.userToken = token;
      // Save all tokens from the response for completeness
      if (authInfo?.refreshToken) existing.response.data.authInfo.refreshToken = authInfo.refreshToken;
      if (authInfo?.permsToken) existing.response.data.authInfo.permsToken = authInfo.permsToken;
      if (authInfo?.token) existing.response.data.authInfo.token = authInfo.token;
      // Extract entity from JWT claims (the AUTH_TOKEN has defaultEntityId/entities)
      const jwt = parseJwt(token);
      const entityId = authInfo?.entityId || jwt?.payload?.defaultEntityId || jwt?.payload?.entities?.[0]?.entityId;
      const entityTypeId = authInfo?.entityTypeId || jwt?.payload?.defaultEntityTypeId || jwt?.payload?.entities?.[0]?.entityTypeId;
      if (entityId) existing.response.data.authInfo.entityId = entityId;
      if (entityTypeId) existing.response.data.authInfo.entityTypeId = entityTypeId;
      writePrivateJson(authPath, existing);
      console.log(`  auth        : valid JWT saved to ${authPath}`);
      if (entityId) console.log(`  entity      : ${entityId}${entityTypeId ? ` (type ${entityTypeId})` : ""}`);
      // Show entity count if multiple entities available
      if (jwt?.payload?.entities?.length > 1) {
        console.log(`  entities    : ${jwt.payload.entities.length} available`);
      }
    } else {
      console.log(`  auth        : no token in response`);
      process.exitCode = 1;
    }

    // Update profile with verify status
    const profilePath = process.env.PROFILE_PATH || "profile.json";
    try {
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      profile.lastVerifyAt = new Date().toISOString();
      profile.lastVerifyStatus = token ? "ok" : "failed";
      writePrivateJson(profilePath, profile);
    } catch { /* profile doesn't exist yet — skip */ }

    if (res.json) console.log(`  body        :`, JSON.stringify(res.json, null, 2));
    else console.log(`  body        :`, res.body);
  } finally {
    await nusuk.close();
  }
}

async function cmdRefreshToken(args) {
  // Refresh the auth token using the stored refresh token from auth.json.
  // If no refresh token is available, falls back to a full re-login using
  // the saved profile (profile.json from a previous `login-auto`).
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const authPath = process.env.AUTH_PATH || "auth.json";
  const profilePath = process.env.PROFILE_PATH || "profile.json";

  // Try refresh token first
  let existing = {};
  try { existing = JSON.parse(readFileSync(authPath, "utf8")); } catch { /* ignore */ }
  const refreshToken = existing?.response?.data?.authInfo?.refreshToken;

  if (refreshToken) {
    console.log(`Refreshing token via /eh/public/authentication/refreshToken...`);
    const nusuk = new Nusuk({ referer: "https://masar.nusuk.sa/pub/login" });
    await nusuk.init();
    try {
      const res = await nusuk.request("/eh/public/authentication/refreshToken", {
        method: "POST",
        payload: { refreshToken },
      });
      console.log(`  status   : ${res.status}`);
      if (res.timing) console.log(`  timing   :`, res.timing);

      const data = res.json?.response?.data;
      const newToken = data?.userToken || data?.token;
      if (newToken) {
        existing.response.data.authInfo.userToken = newToken;
        if (data?.refreshToken) existing.response.data.authInfo.refreshToken = data.refreshToken;
        if (data?.permsToken) existing.response.data.authInfo.permsToken = data.permsToken;
        if (data?.token) existing.response.data.authInfo.token = data.token;
        // Re-extract entity from the new JWT
        const jwt = parseJwt(newToken);
        const entityId = jwt?.payload?.defaultEntityId || jwt?.payload?.entities?.[0]?.entityId;
        const entityTypeId = jwt?.payload?.defaultEntityTypeId || jwt?.payload?.entities?.[0]?.entityTypeId;
        if (entityId) existing.response.data.authInfo.entityId = entityId;
        if (entityTypeId) existing.response.data.authInfo.entityTypeId = entityTypeId;
        writePrivateJson(authPath, existing);
        console.log(`  auth     : valid JWT saved to ${authPath}`);
        if (entityId) console.log(`  entity   : ${entityId}${entityTypeId ? ` (type ${entityTypeId})` : ""}`);
        if (res.json) console.log(`  body     :`, JSON.stringify(res.json, null, 2));
        return;
      }
      console.log(`  auth     : no token in refresh response`);
      if (res.json) console.log(`  body     :`, JSON.stringify(res.json, null, 2));
    } finally {
      await nusuk.close();
    }
  }

  // No refresh token — fall back to full re-login using saved profile
  console.log(`No refresh token found in auth.json.`);
  let profile = null;
  try { profile = JSON.parse(readFileSync(profilePath, "utf8")); } catch { /* ignore */ }
  if (!profile || !profile.username || !profile.password) {
    throw new Error(`No refresh token and no saved profile. Run "nusuk login-auto" first to create a profile.`);
  }
  console.log(`Falling back to full re-login using saved profile (${profile.username})...`);
  const reloginArgs = ["--username", profile.username, "--password", profile.password];
  if (profile.aesKey) reloginArgs.push("--aes-key", profile.aesKey);
  if (profile.xChannel) reloginArgs.push("--x-channel", profile.xChannel);
  if (profile.trustedDeviceToken) reloginArgs.push("--trusted-device-token", profile.trustedDeviceToken);
  if (profile.captcha?.provider === "capmonster") reloginArgs.push("--capmonster");
  if (profile.captcha?.siteKey) reloginArgs.push("--site-key", profile.captcha.siteKey);
  if (profile.captcha?.pageUrl) reloginArgs.push("--page-url", profile.captcha.pageUrl);
  await cmdAutoLogin(reloginArgs);
}

async function cmdPull(args) {
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const entityId =
    getArg("--entity") || process.env.ACTIVE_ENTITY_ID || readEntityId();
  const type = getArg("--type") || "visa";
  const endpoint = getArg("--endpoint");

  if (!entityId) {
    console.error("Entity ID required. Use --entity <id> or set activeEntityId in entity.json");
    process.exit(1);
  }

  const { token, captcha, authPath, captchaPath, entityId: tokenEntityId } = await pullCreds({ entityId, type, endpoint });

  console.log(`\n┌─ Pull from worker (entity ${entityId}, type ${type})`);
  if (!token) console.log(`│  ⚠ no auth token found in worker records`);
  if (!captcha) console.log(`│  ⚠ no ${type} captcha found in worker`);

  console.log(`│  ${token ? "✓" : "✗"} auth    → ${authPath}${token ? "" : " (skipped — none found)"}`);
  console.log(`│  ${captcha ? "✓" : "✗"} captcha → ${captchaPath}${captcha ? "" : " (skipped — none found)"}`);
  if (token) console.log(`│  • token   ${token.slice(0, 28)}... (entity ${tokenEntityId})`);
  if (captcha) console.log(`│  • captcha ${captcha.slice(0, 28)}...`);
  console.log(`└─`);

  if (!token && !captcha) process.exitCode = 1;
}

/**
 * cmdWorkflow — manage Cloudflare Workflow instances for scheduled visa sends.
 *
 * Usage:
 *   nusuk workflow status <instanceId>     Check status of a workflow instance
 *   nusuk workflow terminate <instanceId>  Terminate a workflow instance
 */
async function cmdWorkflow(args) {
  const sub = args[0] || "";
  const workerUrl = process.env.WORKER_URL || "https://toque.decloud.workers.dev";
  const base = workerUrl.replace(/\/+$/, "");

  if (sub === "status") {
    const instanceId = args[1];
    if (!instanceId) {
      console.error("Usage: nusuk workflow status <instanceId>");
      process.exitCode = 1;
      return;
    }
    const resp = await fetch(`${base}/schedule/workflow/status?instanceId=${encodeURIComponent(instanceId)}`);
    const json = await resp.json();
    if (!json.ok) {
      console.error(`Error: ${json.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(json.status, null, 2));
    return;
  }

  if (sub === "terminate" || sub === "stop") {
    const instanceId = args[1];
    if (!instanceId) {
      console.error("Usage: nusuk workflow terminate <instanceId>");
      process.exitCode = 1;
      return;
    }
    const resp = await fetch(`${base}/schedule/workflow/terminate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId }),
    });
    const json = await resp.json();
    if (!json.ok) {
      console.error(`Error: ${json.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Workflow ${instanceId} terminated.`);
    return;
  }

  console.log(`Usage: nusuk workflow <status|terminate> <instanceId>`);
  console.log(`  status    Check the status of a workflow instance`);
  console.log(`  terminate Terminate a running workflow instance`);
}

async function autoPull(type = "visa") {
  try {
    const result = await pullCreds({ type, quiet: true });
    if (result.token || result.captcha) {
      const files = [result.token && result.authPath, result.captcha && result.captchaPath]
        .filter(Boolean)
        .join(" and ");
      console.log(`  auto-created ${files} from worker`);
    }
    return result;
  } catch (e) {
    console.error(`  auto-pull from worker failed: ${e.message}`);
    return {};
  }
}

async function cmdBench(args) {
  const count = parsePositiveCount(args[0]);
  if (count === null) {
    throw new Error("Benchmark count must be an integer from 1 to 100");
  }
  const authPath = findAuth();
  const nusuk = authPath ? new Nusuk().loadAuth(authPath).loadEntity() : new Nusuk().loadEntity();
  await nusuk.init();

  try {
    console.log(`\n┌─ Benchmark: ${count} requests to ${nusuk.baseUrl}\n│`);
    const samples = [];
    for (let i = 0; i < count; i++) {
      const res = await nusuk.request("/manifest.json", { cacheBust: true });
      const t = res.timing;
      samples.push(t);
      const statusIcon = res.status === 200 ? "✓" : "✗";
      console.log(`│  ${statusIcon} req ${String(i + 1).padStart(2)}  total=${ms(t.total).padStart(6)}  ttfb=${ms(t.ttfb ?? "?").padStart(6)}  status=${res.status}`);
    }

    const totals = samples.map((s) => s.total);
    const ttfbVals = samples.map((s) => s.ttfb).filter((v) => v != null && v > 0);
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const min = (arr) => Math.min(...arr);
    const max = (arr) => Math.max(...arr);

    console.log(`│\n├─ Latency Summary ───────────────────────────────────────`);
    console.log(`│  total RTT   min=${ms(min(totals)).padStart(6)}  avg=${ms(avg(totals)).padStart(6)}  max=${ms(max(totals)).padStart(6)}`);
    if (ttfbVals.length) {
      console.log(`│  ttfb        min=${ms(min(ttfbVals)).padStart(6)}  avg=${ms(avg(ttfbVals)).padStart(6)}  max=${ms(max(ttfbVals)).padStart(6)}  (${ttfbVals.length}/${count} samples)`);
      const minTtfb = min(ttfbVals);
      const avgTtfb = avg(ttfbVals);
      console.log(`│  server proc ${ms(avgTtfb - minTtfb).padStart(6)}  (avg ttfb - min ttfb)`);
      const netOneWay = Math.round(minTtfb / 2);
      console.log(`│  net 1-way   ${ms(netOneWay).padStart(6)}  (min ttfb ÷ 2)  ← request delivery`);
      const oneway = netOneWay || Math.round(avg(totals) / 2);
      console.log(`│  one-way ~   ${ms(oneway).padStart(6)}`);
    } else {
      console.log(`│  ttfb        (no resource timing entries — enable cacheBust or check browser)`);
      const oneway = Math.round(avg(totals) / 2);
      console.log(`│  one-way ~   ${ms(oneway).padStart(6)}`);
    }
  } finally {
    await nusuk.close();
  }
}

async function cmdReq(args) {
  const { payload: initialPayload, captchaType, useCaptcha } = parsePayloadOptions(args, { defaultCaptchaType: "visa" });
  const rawJson = args.includes("--raw-json");
  const dataIdx = args.indexOf("--data");
  const captchaTypeIndex = args.indexOf("--captcha-type");
  const clean = args.filter((value, index) =>
    value !== "--captcha" &&
    value !== "--raw-json" &&
    value !== "--captcha-type" &&
    value !== "--data" &&
    (dataIdx === -1 || index !== dataIdx + 1) &&
    (captchaTypeIndex === -1 || index !== captchaTypeIndex + 1)
  );
  const path = clean[0];
  const method = (clean[1] || (initialPayload !== undefined ? "POST" : "GET")).toUpperCase();
  if (!path) {
    console.error("Usage: nusuk request <path> [method] [--data <json>] [--captcha] [--captcha-type <type>]");
    process.exit(1);
  }

  let payload = initialPayload;
  if (payload === undefined && ["POST", "PUT", "PATCH"].includes(method)) {
    payload = {};
  }
  if (useCaptcha) {
    const token = readCaptchaToken(captchaType);
    if (!token) console.error("Warning: captcha.json not found or empty");
    payload = injectCaptchaToken(payload, token);
  }

  const res = await executeRequest({ path, method, payload, useCaptcha, captchaType });
  if (rawJson) {
    if (res.json === null) {
      console.error(JSON.stringify({
        error: "Response is not JSON",
        status: res.status,
        contentType: res.headers?.["content-type"] || null,
        url: res.url,
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify(res.json, null, 2));
    return;
  }
  const statusIcon = res.ok ? "✓" : "✗";
  console.log(`\n${statusIcon} ${method} ${path} → ${res.status}`);
  if (res.timing) console.log(`⏱  total=${ms(res.timing.total)}  ttfb=${ms(res.timing.ttfb ?? "?")}`);
  if (res.json) console.log(`\n${JSON.stringify(res.json, null, 2)}`);
  else console.log(`\n${res.body}`);
}

async function executeRequest({ path, method = "GET", payload, useCaptcha = false, captchaType = "visa" }) {
  let authPath = findAuth();
  if (!authPath || (useCaptcha && !payload?.captchaToken)) {
    const pulled = await autoPull(captchaType);
    authPath = authPath || (pulled.token ? pulled.authPath : null);
    if (useCaptcha && !payload?.captchaToken && pulled.captcha) {
      payload = { ...(payload || {}), captchaToken: pulled.captcha };
    }
  }

  const nusuk = authPath ? new Nusuk().loadAuth(authPath).loadEntity() : new Nusuk().loadEntity();
  await nusuk.init();

  try {
    return await nusuk.request(path, { method, payload });
  } finally {
    await nusuk.close();
  }
}

function printNamedRequests() {
  console.log("Available requests:\n");
  for (const request of listRequests()) {
    console.log(`  ${request.name.padEnd(24)} ${request.method.padEnd(6)} ${request.description}`);
  }
  console.log("\nRun: nusuk api <name> [--raw-json]");
}

async function cmdApi(args) {
  const [name, ...options] = args;
  if (!name || name === "list") {
    printNamedRequests();
    return;
  }
  const request = getRequest(name);
  if (!request) {
    throw new Error(`Unknown request: ${name}. Run "nusuk api list" to see available requests`);
  }

  const requestArgs = [request.path, request.method];
  if (request.payload !== undefined) {
    requestArgs.push("--data", JSON.stringify(request.payload));
  }
  if (request.captcha) requestArgs.push("--captcha");
  if (options.includes("--raw-json")) requestArgs.push("--raw-json");
  return cmdReq(requestArgs);
}

async function fetchGroups({ limit = 10, offset = 0 } = {}) {
  const request = getRequest("group-list");
  const payload = { ...request.payload, limit, offset };
  const response = await executeRequest({
    path: request.path,
    method: request.method,
    payload,
  });
  if (response.json === null) throw new Error("Group list response is not JSON");
  const groups = extractGroups(response.json);
  if (groups === null) {
    throw new Error("Unsupported group-list response shape. Run `nusuk api group-list --raw-json` to inspect it");
  }
  return { groups, response };
}

async function cmdGroups(args) {
  const [action = "list", ...options] = args;
  if (action !== "list") throw new Error("Usage: nusuk groups list [--limit 10] [--offset 0] [--raw-json]");
  const getArg = (flag) => {
    const index = options.indexOf(flag);
    return index === -1 ? undefined : options[index + 1];
  };
  const limit = parsePositiveCount(getArg("--limit"), 10, 100);
  const offsetText = getArg("--offset") ?? "0";
  if (limit === null) throw new Error("Group limit must be an integer from 1 to 100");
  if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(Number(offsetText))) {
    throw new Error("Group offset must be a non-negative integer");
  }
  const { groups, response } = await fetchGroups({ limit, offset: Number(offsetText) });
  if (options.includes("--raw-json")) {
    console.log(JSON.stringify(response.json, null, 2));
    return;
  }
  console.log(`Groups (${groups.length}):\n`);
  console.log(formatGroups(groups));
}

async function selectGroup() {
  if (!canPrompt()) {
    throw new Error("Group ID is required in non-interactive mode. Run `nusuk groups list` or pass `nusuk send <group-id>`");
  }
  const { groups } = await fetchGroups();
  if (!groups.length) throw new Error("No groups found for the active entity");
  console.log(`\nSelect a group:\n\n${formatGroups(groups)}\n`);
  const selected = parseGroupSelection(await ask(`Choose 1-${groups.length} (or 0 to cancel): `), groups);
  if (!selected) return null;
  console.log(`Selected: ${selected.name} (ID: ${selected.id})`);
  return selected;
}

async function cmdSetGroupId(args = []) {
  const value = args[0] || null;
  if (!value) {
    console.error("Group ID is required. Usage: nusuk set-group-id <group-id>");
    process.exitCode = 1;
    return;
  }
  writeStoredGroupId(value);
  console.log(`Stored group ID: ${value}`);
}

async function cmdCaptchaSet(args = []) {
  const getArg = (flag) => {
    const index = args.indexOf(flag);
    return index !== -1 ? args[index + 1] : undefined;
  };
  const type = getArg("--type") || "visa";
  let token = getArg("--token");
  if (!token) {
    token = args.find((arg, index) => {
      if (arg.startsWith("-")) return false;
      return arg !== type || args[args.indexOf("--type") + 1] !== arg;
    });
  }
  token = token || process.env.CAPTCHA_TOKEN || "";
  if (!token) token = await ask("CAPTCHA token: ") || "";
  if (!token) {
    throw new Error("CAPTCHA token is required. Pass a token, use --token, or set CAPTCHA_TOKEN");
  }
  writeCaptchaToken(token, normalizeCaptchaType(type));
  console.log(`CAPTCHA token updated (${normalizeCaptchaType(type)})`);
}

async function cmdCaptchaShow() {
  const captchaPath = findCaptcha();
  if (!captchaPath) {
    console.log("captcha file not found (tried captcha.json)");
    return;
  }
  const data = JSON.parse(readFileSync(captchaPath, "utf8"));
  const hasVisa = typeof data.visa === "string" && data.visa;
  const hasLogin = typeof data.login === "string" && data.login;
  const hasGeneral = typeof data.general === "string" && data.general;
  const typedCount = [hasVisa, hasLogin, hasGeneral].filter(Boolean).length;

  if (typedCount > 1) {
    console.log(JSON.stringify({
      visa: data.visa || null,
      login: data.login || null,
      general: data.general || null,
    }, null, 2));
  } else if (typedCount === 1) {
    console.log(data.visa || data.login || data.general);
  } else {
    console.log(data.captchaToken || "(empty)");
  }
}

async function cmdCaptchaSolve(args) {
  const version = args.includes("--v3") ? 3 : 2;
  const type = args.includes("--type") ? args[args.indexOf("--type") + 1] : "visa";
  const provider = args.includes("--capmonster") ? "capmonster" : "capsolver";
  const enterprise = args.includes("--enterprise");
  const turnstile = args.includes("--turnstile");
  const normalizedType = normalizeCaptchaType(type);
  const start = Date.now();

  if (provider === "capmonster") {
    const solver = new CapMonsterSolver();
    const captchaType = turnstile ? "turnstile" : "recaptcha";
    console.log(`Solving ${turnstile ? "Turnstile" : `reCAPTCHA v${version}${enterprise ? " Enterprise" : ""}`} via CapMonster Cloud (${solver.pageUrl})...`);
    const token = await solver.solve({
      version,
      type: captchaType,
      enterprise,
      timeout: 180000,
    });
    writeCaptchaToken(token, normalizedType);
    console.log(`\n  captcha token saved (${normalizedType}, ${((Date.now() - start) / 1000).toFixed(1)}s)`);
    console.log(`  token: ${token.slice(0, 28)}...`);
    return;
  }

  // Default: CapSolver
  const solver = new CapSolver();
  const captchaType = turnstile ? "turnstile" : "recaptcha";
  console.log(`Solving ${turnstile ? "Turnstile" : `reCAPTCHA v${version}${enterprise ? " Enterprise" : ""}`} via CapSolver (${solver.pageUrl})...`);
  const token = await solver.solve({
    version,
    type: captchaType,
    enterprise,
  });
  writeCaptchaToken(token, normalizedType);
  console.log(`\n  captcha token saved (${normalizedType}, ${((Date.now() - start) / 1000).toFixed(1)}s)`);
  console.log(`  token: ${token.slice(0, 28)}...`);
}

async function cmdCaptchaBalance(args) {
  const provider = args.includes("--capmonster") ? "capmonster" : "capsolver";

  if (provider === "capmonster") {
    const solver = new CapMonsterSolver();
    console.log("Checking CapMonster Cloud balance...");
    const { balance } = await solver.getBalance();
    console.log(`  CapMonster Cloud balance: $${balance}`);
    return;
  }

  // CapSolver — use the SDK
  const solver = new CapSolver();
  console.log("Checking CapSolver balance...");
  const { balance } = await solver.getBalance();
  console.log(`  CapSolver balance: $${balance}`);
}

function captchaPullOptions(args) {
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    entityId: getArg("--entity") || process.env.ACTIVE_ENTITY_ID || readEntityId(),
    type: normalizeCaptchaType(getArg("--type") || process.env.CAPTCHA_PULL_TYPE || "visa"),
    endpoint: getArg("--endpoint"),
    outputPath: getArg("--output") || process.env.CAPTCHA_PATH || "captcha.json",
    interval: parseInterval(getArg("--interval") || process.env.CAPTCHA_PULL_INTERVAL, 5000),
    pidPath: resolve(getArg("--pid-file") || process.env.CAPTCHA_PULL_PID || ".nusuk-captcha.pid"),
    quiet: args.includes("--quiet"),
    strict: !args.includes("--fallback"),
  };
}

async function cmdCaptchaPull(args) {
  const options = captchaPullOptions(args);
  const result = await pullCaptchaOnce(options);
  if (!result.token) {
    throw new Error(`No ${options.type} CAPTCHA available for entity ${options.entityId}`);
  }
  if (!options.quiet) {
    console.log(`${options.type} CAPTCHA ${result.updated ? "saved" : "unchanged"} -> ${result.outputPath}`);
  }
}

async function cmdCaptchaWatch(args) {
  const options = captchaPullOptions(args);
  if (!options.entityId) throw new Error("Entity ID required (pass --entity or configure entity.json)");

  const existing = readPidFile(options.pidPath);
  if (existing && existing.pid !== process.pid && isProcessRunning(existing.pid)) {
    throw new Error(`CAPTCHA puller already running (PID ${existing.pid})`);
  }
  writePrivateJson(options.pidPath, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    entityId: String(options.entityId),
    type: options.type,
    outputPath: resolve(options.outputPath),
  });

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!options.quiet) {
      console.log(`Watching ${options.type} CAPTCHA for entity ${options.entityId} every ${options.interval}ms`);
    }
    await runCaptchaPullLoop({ ...options, signal: controller.signal });
  } finally {
    const owned = readPidFile(options.pidPath);
    if (owned?.pid === process.pid) {
      try { unlinkSync(options.pidPath); } catch {}
    }
  }
}

async function cmdCaptchaStart(args) {
  const options = captchaPullOptions(args);
  if (!options.entityId) throw new Error("Entity ID required (pass --entity or configure entity.json)");
  const existing = readPidFile(options.pidPath);
  if (existing && isProcessRunning(existing.pid)) {
    throw new Error(`CAPTCHA puller already running (PID ${existing.pid})`);
  }
  if (existing) {
    try { unlinkSync(options.pidPath); } catch {}
  }

  const childArgs = [
    fileURLToPath(import.meta.url), "captcha", "watch",
    "--type", options.type,
    "--entity", String(options.entityId),
    "--output", options.outputPath,
    "--interval", String(options.interval),
    "--pid-file", options.pidPath,
    "--quiet",
  ];
  const endpointIndex = args.indexOf("--endpoint");
  if (endpointIndex !== -1 && args[endpointIndex + 1]) {
    childArgs.push("--endpoint", args[endpointIndex + 1]);
  }
  if (args.includes("--fallback")) childArgs.push("--fallback");

  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  if (!options.quiet) console.log(`CAPTCHA puller started (PID ${child.pid}, type ${options.type})`);
}

async function cmdCaptchaStatus(args) {
  const options = captchaPullOptions(args);
  const state = readPidFile(options.pidPath);
  if (!state || !isProcessRunning(state.pid)) {
    if (state) try { unlinkSync(options.pidPath); } catch {}
    console.log("CAPTCHA puller is not running");
    process.exitCode = 1;
    return;
  }
  console.log(`CAPTCHA puller running (PID ${state.pid}, type ${state.type}, entity ${state.entityId})`);
}

async function cmdCaptchaStop(args) {
  const options = captchaPullOptions(args);
  const state = readPidFile(options.pidPath);
  if (!state || !isProcessRunning(state.pid)) {
    if (state) try { unlinkSync(options.pidPath); } catch {}
    console.log("CAPTCHA puller is not running");
    return;
  }
  process.kill(state.pid, "SIGTERM");
  console.log(`Stopping CAPTCHA puller (PID ${state.pid})`);
}

async function cmdCaptcha(args) {
  const [action = "help", ...rest] = args;
  switch (action) {
    case "pull": return cmdCaptchaPull(rest);
    case "watch": return cmdCaptchaWatch(rest);
    case "start": return cmdCaptchaStart(rest);
    case "status": return cmdCaptchaStatus(rest);
    case "stop": return cmdCaptchaStop(rest);
    case "set": return cmdCaptchaSet(rest);
    case "show": return cmdCaptchaShow();
    case "solve": return cmdCaptchaSolve(rest);
    case "balance": return cmdCaptchaBalance(rest);
    case "help": help("captcha"); return;
    default: throw new Error("Usage: nusuk captcha <pull|watch|start|status|stop|set|show|solve|balance>");
  }
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.round(Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length));
}

function connectionQuality(stddev) {
  if (stddev <= 5) return { label: "stable", icon: "\u2714" };
  if (stddev <= 15) return { label: "moderate", icon: "\u26a0" };
  return { label: "jittery", icon: "\u274c" };
}

async function calibrate(nusuk, count, label) {
  console.log(`  ${label}`);
  const samples = [];
  for (let i = 0; i < count; i++) {
    const res = await nusuk.request("/manifest.json");
    samples.push(res.timing);
    console.log(`    req ${i + 1}: total=${ms(res.timing.total)}  ttfb=${ms(res.timing.ttfb ?? "?")}  status=${res.status}`);
  }
  return samples;
}

async function cmdSchedule(args) {
  const targetIdx = args.indexOf("--target");
  const scheduleIdx = args.indexOf("--schedule");
  const targetStr = targetIdx !== -1 ? args[targetIdx + 1] : scheduleIdx !== -1 ? args[scheduleIdx + 1] : null;
  const pathIdx = args.indexOf("--path");
  const path = pathIdx !== -1 ? args[pathIdx + 1] : "/umrah/groups_apis/api/Groups/SendToIssueVisa";
  const methodIdx = args.indexOf("--method");
  const method = methodIdx !== -1 ? args[methodIdx + 1].toUpperCase() : "POST";
  const countIdx = args.indexOf("--count");
  const count = parsePositiveCount(countIdx !== -1 ? args[countIdx + 1] : undefined);
  let { payload, captchaType, useCaptcha } = parsePayloadOptions(args, { defaultCaptchaType: "visa" });
  if (useCaptcha) {
    const token = readCaptchaToken(captchaType);
    if (!token) console.error("Warning: captcha.json not found or empty");
    payload = injectCaptchaToken(payload, token);
  }

  if (!targetStr) {
    console.error("Usage: nusuk schedule --target HH:MM:SS [--path /api/endpoint] [--count 5] [--captcha] [--captcha-type <type>]");
    process.exit(1);
  }
  if (count === null) {
    throw new Error("Calibration count must be an integer from 1 to 100");
  }
  const target = parseTargetTime(targetStr);
  if (!target) {
    console.error("Invalid target time. Use HH:MM:SS[.mmm] or HH:MM:SS:mmm");
    process.exit(1);
  }

  let authPath = findAuth();
  if (!authPath || (useCaptcha && !payload?.captchaToken)) {
    const pulled = await autoPull(captchaType);
    authPath = authPath || (pulled.token ? pulled.authPath : null);
    if (useCaptcha && !payload?.captchaToken && pulled.captcha) {
      payload = injectCaptchaToken(payload, pulled.captcha);
    }
  }
  if (!authPath) {
    console.error("No auth token found. Run `nusuk pull` first or check auth.json");
    process.exitCode = 1;
    return;
  }
  const nusuk = new Nusuk().loadAuth(authPath).loadEntity();
  await nusuk.init();

  try {
    // Phase 1: warm-up (establish connection, dismiss outliers)
    const warmup = await calibrate(nusuk, 2, "Warm-up");

    // Phase 2: full calibration
    const samples = await calibrate(nusuk, count, "Calibration");

    const totals = samples.map((s) => s.total);
    const ttfbVals = samples.map((s) => s.ttfb).filter(Boolean);
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    // Use calibration data, fall back to warm-up if all cached (<2ms)
    let pool = [...samples.map((s) => s.ttfb).filter((v) => v > 2)];
    if (pool.length === 0) {
      pool = [...warmup.map((s) => s.ttfb).filter((v) => v > 2)];
    }
    const minTtfb = pool.length ? Math.min(...pool) : (ttfbVals.length ? Math.min(...ttfbVals) : null);
    const avgRealTtfb = pool.length ? avg(pool) : minTtfb;
    const sdTtfb = pool.length ? stddev(pool) : 0;

    // Weighted one-way: bias toward min but include avg for jitter
    const netOneWay = minTtfb ? Math.round((minTtfb * 0.6 + avgRealTtfb * 0.4) / 2) : Math.round(Math.min(...totals) / 4);
    const jitterBuffer = Math.min(sdTtfb + 20, 120);
    const sendAhead = netOneWay + jitterBuffer;
    const sendAt = new Date(target.getTime() - sendAhead);

    const quality = connectionQuality(sdTtfb);
    const driftRange = sdTtfb > 0 ? `\u00b1${sdTtfb}ms` : "\u22645ms";

    console.log(`\n┌─ Connection Quality ${quality.icon} ${quality.label}`);
    console.log(`│  • stability     stddev ${ms(sdTtfb)}, drift ~${driftRange}`);
    console.log(`│  ⏱ min ttfb      ${ms(minTtfb)}`);
    console.log(`│  ⏱ avg ttfb      ${ms(avgRealTtfb)}`);
    console.log(`│  ⏱ weighted 1-way ${ms(netOneWay)}  (min×0.6 + avg×0.4 ÷ 2)`);
    console.log(`│  ⏱ jitter buffer ${ms(jitterBuffer)}`);
    console.log(`│\n├─ Schedule`);
    console.log(`│  ⏱ deliver to server  ${formatTime(target)}`);
    console.log(`│  ⏱ send at            ${formatTime(sendAt)}  (${ms(sendAhead)} ahead)`);

    const waitMs = sendAt.getTime() - Date.now();
    if (waitMs > 0) {
      console.log(`│\n│  ⏱ waiting ${ms(waitMs)}...`);

      // Phase 3: mid-calibration refresh at 60% of wait time
      if (waitMs > 5000) {
        const midWait = Math.round(waitMs * 0.6);
        await new Promise((r) => setTimeout(r, midWait));
        const refresh = await calibrate(nusuk, 2, "Mid-calibration refresh");

        const refreshTtfb = refresh.map((s) => s.ttfb).filter((v) => v > 2).filter(Boolean);
        if (refreshTtfb.length) {
          const refreshMin = Math.min(...refreshTtfb);
          const refreshAvg = avg(refreshTtfb);
          const refreshOneWay = Math.round((refreshMin * 0.6 + refreshAvg * 0.4) / 2);
          const adjustedAhead = refreshOneWay + jitterBuffer;
          const adjustedSend = new Date(target.getTime() - adjustedAhead);
          if (adjustedSend.getTime() < sendAt.getTime() + 200 && adjustedSend.getTime() > Date.now()) {
            console.log(`│  ↳ refresh 1-way: ${ms(refreshOneWay)}  → adjusting send time`);
            sendAt.setTime(adjustedSend.getTime());
          } else {
            console.log(`│  ↳ refresh 1-way: ${ms(refreshOneWay)}  (keep original schedule)`);
          }
        }
      }

      const remaining = sendAt.getTime() - Date.now();
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));

      const sendActual = Date.now();
      const res = await nusuk.request(path, { method, payload });
      const responseReceived = Date.now();
      const serverArrival = sendActual + netOneWay;
      const drift = serverArrival - target.getTime();

      const statusIcon = res.status === 200 ? "✓" : "✗";
      console.log(`│\n├─ Result ${statusIcon}`);
      console.log(`│  ⏱ sent at          ${formatTime(new Date(sendActual))}`);
      console.log(`│  ⏱ ~server arrival  ${formatTime(new Date(serverArrival))}`);
      console.log(`│  ⏱ target           ${formatTime(target)}`);
      console.log(`│  ⏱ drift            ${drift >= 0 ? "+" : ""}${drift}ms`);
      console.log(`│  ⬇ response received ${formatTime(new Date(responseReceived))}`);
      console.log(`│  ${statusIcon} response status  ${res.status}`);
      if (res.timing) {
        console.log(`│  ⏱ actual ttfb      ${ms(res.timing.total)}`);
      }
      if (res.json) console.log(`│  • response         ${JSON.stringify(res.json, null, 2).slice(0, 600).split("\n").join("\n│  ")}`);
      console.log(`└─`);
    } else {
      console.log(`│  ⚠ target ${formatTime(target)} is too close or in the past.`);
      console.log(`└─`);
    }
  } finally {
    await nusuk.close();
  }
}

const VISA_PATH = "/umrah/groups_apis/api/Groups/SendToIssueVisa";
const TOKEN_TEST_PATH = "/umrah/contracts_apis/api/UoSubscription/VerifySubscriptionStatus";
const CAPTCHA_REFRESH_AHEAD = 20 * 1000;

async function refreshVisaCaptcha(entityId, endpoint) {
  const worker = new AuthaWorker({ endpoint, entityId });
  const captcha = await worker.fetchLatestCaptcha(entityId, "visa");
  if (captcha) {
    writeCaptchaToken(captcha);
    console.log(`  refreshed visa captcha -> captcha.json`);
  }
  return captcha;
}

async function warmVisaConnection(nusuk, targetTime) {
  const warmupSamples = await calibrate(nusuk, 5, "Warm-up");
  return computeSendSchedule(targetTime, warmupSamples, {
    jitterBufferMs: 40,
    clientOverheadMs: 80,
  });
}

async function cmdSendVisa(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: nusuk send-visa <group-id> [--target HH:MM:SS|--schedule HH:MM:SS] [--workflow] [--data '{"key":"value"}'] [--captcha] [--captcha-type <type>] [--no-test] [--endpoint <url>] [--test-path <path>]`);
    console.log(`  --workflow  Create a Cloudflare Workflow instance for durable scheduled execution (no blocking)`);
    return;
  }

  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const useWorkflow = args.includes("--workflow");
  const valueFlags = new Set(["--target", "--schedule", "--test-path", "--endpoint", "--data", "--captcha-type", "--no-test", "schedule"]);
  let groupId;
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) {
      i++;
    } else if (!args[i].startsWith("-")) {
      groupId = args[i];
      break;
    }
  }
  const targetStr = getArg("--target") || getArg("--schedule") || (args.includes("schedule") ? args[args.indexOf("schedule") + 1] : undefined);
  const target = targetStr ? parseTargetTime(targetStr) : null;
  const testPath = getArg("--test-path");
  const endpoint = getArg("--endpoint");
  const { payload: dataPayload, captchaType, useCaptcha } = parsePayloadOptions(args, { defaultCaptchaType: "visa" });

  if (!groupId) {
    groupId = process.env.GROUP_ID || null;
  }
  if (!groupId) {
    groupId = readStoredGroupId() || null;
  }
  if (typeof groupId === "string") groupId = groupId.trim();
  if (!groupId && !canPrompt()) {
    console.error("Group ID is required in non-interactive mode. Pass a group ID or set one with `nusuk set-group-id <id>`.");
    process.exit(1);
  }
  if (!groupId) {
    const selected = await selectGroup();
    if (!selected) {
      console.log("Cancelled.");
      return;
    }
    groupId = selected.id;
  }
  if (targetStr && !target) {
    console.error("Invalid target time. Use HH:MM:SS[.mmm] or HH:MM:SS:mmm, and it must be in the future.");
    process.exit(1);
  }

  // --- Workflow mode: delegate to Cloudflare Workflows for durable execution ---
  if (useWorkflow && target) {
    const workerUrl = getArg("--endpoint") || process.env.WORKER_URL || "https://toque.decloud.workers.dev";
    const workflowEndpoint = `${workerUrl.replace(/\/+$/, "")}/schedule/workflow`;
    const workflowBody = {
      targetTime: target.toISOString(),
      groupId: String(groupId),
      captcha: useCaptcha,
      captchaType,
      payload: dataPayload || null,
      pullBefore: true,
    };
    console.log(`Creating Workflow instance for scheduled send...`);
    console.log(`  target  : ${formatTime(target)}`);
    console.log(`  group   : ${groupId}`);
    console.log(`  endpoint: ${workflowEndpoint}`);
    try {
      const resp = await fetch(workflowEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workflowBody),
      });
      const json = await resp.json();
      if (!json.ok) {
        console.error(`Failed to create workflow: ${json.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n  ✓ Workflow instance created: ${json.instanceId}`);
      console.log(`  Target time: ${json.targetTime}`);
      console.log(`  Group ID: ${json.groupId}`);
      console.log(`\n  Check status:`);
      console.log(`    nusuk workflow status ${json.instanceId}`);
      console.log(`  Or via curl:`);
      console.log(`    curl "${workerUrl.replace(/\/+$/, "")}/schedule/workflow/status?instanceId=${json.instanceId}"`);
      return;
    } catch (e) {
      console.error(`Failed to create workflow: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const entityId = process.env.ACTIVE_ENTITY_ID || readEntityId();
  if (!entityId) {
    console.error("Entity ID required. Set activeEntityId in entity.json or ACTIVE_ENTITY_ID env");
    process.exit(1);
  }

  let authPath = findAuth();
  if (!authPath) {
    const pulled = await autoPull();
    authPath = pulled.token ? pulled.authPath : null;
  }
  if (!authPath) {
    console.error("No auth token found. Run `nusuk pull` first or check auth.json");
    process.exit(1);
  }

  const nusuk = new Nusuk().loadAuth(authPath).loadEntity();
  await nusuk.init();

  try {
    if (args.includes("--no-test")) {
      console.log("  token check skipped (--no-test)");
    } else {
      let status = null;
      let verified = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await nusuk.request(testPath || TOKEN_TEST_PATH, {
          method: "POST",
          payload: {},
        });
        status = res.status;
        verified = status === 200 && res.json?.response?.status === true;
        if (verified) break;
        console.error(`  token check failed (status ${status}), attempt ${attempt}`);
        const worker = new AuthaWorker({ endpoint, entityId });
        const fresh = await worker.fetchLatestAuthToken(entityId);
        if (!fresh) break;
        nusuk.setAuthToken(fresh.token);
        nusuk.setEntityId(fresh.entityId);
        writeAuthToken(fresh.token, fresh.entityId);
        console.log(`  pulled fresh auth token from worker (entity ${fresh.entityId})`);
      }
      if (!verified) {
        console.error(`Token check failed (status ${status}) — aborting before visa send`);
        process.exitCode = 1;
        return;
      }
      console.log(`  token OK (${status})`);
    }

    let payload = dataPayload;
    if (useCaptcha) {
      const token = readCaptchaToken(captchaType);
      if (!token) console.error("Warning: captcha.json not found or empty");
      payload = injectCaptchaToken(payload, token);
    }

    const sendAt = target ? target.getTime() : Date.now();
    const now = Date.now();
    if (target && sendAt <= now) {
      console.error("Target time is already in the past; aborting request.");
      process.exitCode = 1;
      return;
    }
    const refreshAt = sendAt - CAPTCHA_REFRESH_AHEAD;
    const firstWait = refreshAt - now;
    const tokenEntityId = nusuk.entityId || entityId;

    if (firstWait > 0) {
      console.log(
        `  refreshing visa captcha at ${formatTime(new Date(refreshAt))} (20s before target)...`
      );
      await new Promise((r) => setTimeout(r, firstWait));
    }

    let captcha;
    try {
      captcha = await refreshVisaCaptcha(tokenEntityId, endpoint);
    } catch (e) {
      console.warn(`  captcha refresh failed: ${e.message}`);
    }
    if (!captcha) {
      captcha = readCaptchaToken(captchaType);
      if (captcha) {
        console.warn("  worker has no new captcha — reusing captcha.json");
      } else {
        console.error("  no captcha available (worker or captcha.json) — aborting");
        process.exitCode = 1;
        return;
      }
    }

    let schedule = null;
    if (target) {
      schedule = await warmVisaConnection(nusuk, target);
      console.log(`\n┌─ Schedule`);
      console.log(`│  ⏱ target           ${formatTime(target)}`);
      console.log(`│  ⏱ estimated 1-way  ${ms(schedule.oneWayMs)}`);
      console.log(`│  ⏱ send at          ${formatTime(schedule.sendAt)} (${ms(schedule.sendAheadMs)} ahead)`);
      console.log(`└─`);
    }

    const actualSendAt = target ? schedule.sendAt.getTime() : sendAt;
    const secondWait = actualSendAt - Date.now();
    if (secondWait > 0) {
      console.log(`\n⏱ waiting ${ms(secondWait)} until execute (${formatTime(new Date(actualSendAt))})...`);
      await new Promise((r) => setTimeout(r, secondWait));
    }

    const tokenValue = payload?.captchaToken || payload?.recaptchaToken || readCaptchaToken(captchaType) || captcha;
    payload = buildVisaPayload(payload, groupId, tokenValue);
    const sendActual = Date.now();

    const requestPreview = {
      url: VISA_PATH,
      method: "POST",
      headers: await nusuk.buildRequestHeaders(),
      payload,
    };

    console.log(`\n┌─ Request Preview ────────────────────────────────────────`);
    console.log(`│  ➤ ${requestPreview.method} ${requestPreview.url}`);
    console.log(`│  headers: ${JSON.stringify(requestPreview.headers, null, 2).split("\n").join("\n│  ")}`);
    console.log(`│  payload: ${JSON.stringify(requestPreview.payload, null, 2).split("\n").join("\n│  ")}`);
    console.log(`│  curl:`);
    console.log(`│  ${formatCurlPreview(requestPreview.url, requestPreview.headers, requestPreview.payload).split("\n").join("\n│  ")}`);
    console.log(`└─`);

    const res = await nusuk.request(VISA_PATH, { method: "POST", payload });
    const responseReceived = Date.now();
    const timing = summarizeRequestTiming({
      sendAt: new Date(sendActual),
      responseReceivedAt: new Date(responseReceived),
      response: res,
    });

    const statusIcon = res.status === 200 ? "✓" : "✗";
    console.log(`\n┌─ Result ${statusIcon}`);
    console.log(`│  ⏱ sent at          ${formatTime(timing.sendAt)}`);
    console.log(`│  ⬇ response received ${formatTime(timing.responseReceivedAt)}`);
    console.log(`│  ⏱ elapsed          ${ms(timing.elapsedMs)}`);
    console.log(`│  • response date    ${timing.serverDateHeader || "(none)"}`);
    console.log(`│  ${statusIcon} status            ${res.status}`);
    if (res.timing) console.log(`│  ⏱ timing           total=${ms(res.timing.total)}  ttfb=${ms(res.timing.ttfb ?? "?")}`);
    if (res.json) console.log(`│  • response         ${JSON.stringify(res.json, null, 2).slice(0, 600).split("\n").join("\n│  ")}`);
    else console.log(`│  • body             ${String(res.body).slice(0, 600)}`);
    console.log(`└─`);

    if (res.status !== 200) process.exitCode = 1;
  } finally {
    await nusuk.close();
  }
}
// ─── nusuk config — memorized & configurable options ────────────────

/**
 * Config file location: ~/.toque/config.json (or TOQUE_CONFIG_PATH).
 * Stores user preferences that persist across sessions and sync to D1
 * when the Worker is reachable.
 *
 * Supported keys mirror packages/shared/src/config.ts — a flat dotted
 * path like "captcha.provider" or "nusuk.activeEntityId".
 */
function configFilePath() {
  return process.env.TOQUE_CONFIG_PATH ||
    resolve(process.env.HOME || process.env.USERPROFILE || ".", ".toque", "config.json");
}

/** Known config keys with their default values (mirrors DEFAULT_CONFIG). */
const CONFIG_KEYS = {
  "autha.endpoint": "https://autha-worker.decloud.workers.dev",
  "autha.apiToken": "",
  "autha.proxyMode": false,
  "worker.url": "https://toque.decloud.workers.dev",
  "worker.apiKey": "",
  "worker.jwt": "",
  "worker.authMode": "api-key",
  "nusuk.baseUrl": "https://masar.nusuk.sa",
  "nusuk.activeEntityId": "",
  "nusuk.activeEntityTypeId": "",
  "nusuk.systemUserId": "default",
  "captcha.provider": "capsolver",
  "captcha.capmonsterApiKey": "",
  "captcha.capsolverApiKey": "",
  "captcha.siteKey": "6Le-3OwpAAAAAARztuPscqBNbpEY3okMkd7dCoyx",
  "captcha.pageUrl": "https://masar.nusuk.sa/umrah/mutamer-group/group-list",
  "captcha.pageAction": "submit",
  "captcha.minScore": 0.7,
  "container.maxInstances": 3,
  "container.sleepAfter": "60m",
  "container.instanceType": "standard-4",
  "container.regions": ["WEUR"],
  "paths.auth": "auth.json",
  "paths.captcha": "captcha.json",
  "paths.entity": "entity.json",
  "paths.profile": "profile.json",
};

/** Coerce a string CLI value into the right type for a key. */
function coerceConfigValue(key, raw) {
  const def = CONFIG_KEYS[key];
  if (def === undefined) throw new Error(`Unknown config key: "${key}". Run "nusuk config list" for valid keys.`);
  if (typeof def === "boolean") {
    const v = String(raw).toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
    throw new Error(`"${key}" expects a boolean (true/false), got "${raw}"`);
  }
  if (typeof def === "number") {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`"${key}" expects a number, got "${raw}"`);
    return n;
  }
  if (Array.isArray(def)) {
    // comma-separated → array
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  }
  return String(raw);
}

function loadConfigFile() {
  const path = configFilePath();
  try {
    return JSON.parse(readFileSync(path, "utf8") || "{}");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function saveConfigFile(config) {
  const path = configFilePath();
  writePrivateJson(path, config);
}

async function cmdConfig(args) {
  const sub = args[0];
  if (!sub || ["help", "--help", "-h"].includes(sub)) {
    console.log(`
Usage: nusuk config <command> [options]

Commands:
  list                  Show all config keys and current values
  get <key>             Show the value of one key
  set <key> <value>     Set a key (persists to ~/.toque/config.json)
  unset <key>           Remove a key (reverts to default)
  path                  Show the config file location
  sync                  Push local config to the Worker's D1 settings store

Keys are dotted paths, e.g. "captcha.provider" or "nusuk.activeEntityId".
Run "nusuk config list" to see all valid keys.
`);
    return;
  }

  switch (sub) {
    case "list": {
      const local = loadConfigFile();
      console.log("\nToque configuration\n");
      const maxKeyLen = Math.max(...Object.keys(CONFIG_KEYS).map((k) => k.length));
      for (const [key, def] of Object.entries(CONFIG_KEYS)) {
        const value = key in local ? local[key] : def;
        const source = key in local ? "local" : "default";
        const display = Array.isArray(value) ? `[${value.join(", ")}]` :
          typeof value === "string" && value === "" ? "(empty)" : value;
        console.log(`  ${key.padEnd(maxKeyLen)}  ${String(display).padEnd(30)}  [${source}]`);
      }
      console.log(`\nConfig file: ${configFilePath()}`);
      break;
    }
    case "get": {
      const key = args[1];
      if (!key) throw new Error("Usage: nusuk config get <key>");
      if (!(key in CONFIG_KEYS)) throw new Error(`Unknown key: "${key}". Run "nusuk config list".`);
      const local = loadConfigFile();
      const value = key in local ? local[key] : CONFIG_KEYS[key];
      console.log(typeof value === "object" ? JSON.stringify(value) : value);
      break;
    }
    case "set": {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) throw new Error("Usage: nusuk config set <key> <value>");
      const coerced = coerceConfigValue(key, value);
      const local = loadConfigFile();
      local[key] = coerced;
      saveConfigFile(local);
      console.log(`✓ ${key} = ${Array.isArray(coerced) ? `[${coerced.join(", ")}]` : coerced}`);
      console.log(`  saved to ${configFilePath()}`);
      break;
    }
    case "unset": {
      const key = args[1];
      if (!key) throw new Error("Usage: nusuk config unset <key>");
      if (!(key in CONFIG_KEYS)) throw new Error(`Unknown key: "${key}". Run "nusuk config list".`);
      const local = loadConfigFile();
      if (key in local) {
        delete local[key];
        saveConfigFile(local);
        console.log(`✓ ${key} unset (reverted to default: ${CONFIG_KEYS[key]})`);
      } else {
        console.log(`${key} is not set locally (already using default)`);
      }
      break;
    }
    case "path": {
      console.log(configFilePath());
      break;
    }
    case "sync": {
      await cmdConfigSync();
      break;
    }
    default:
      throw new Error(`Unknown config command: "${sub}". Run "nusuk config help".`);
  }
}

/** Push local config to the Worker's D1 settings store (best-effort). */
async function cmdConfigSync() {
  const local = loadConfigFile();
  const keys = Object.keys(local);
  if (keys.length === 0) {
    console.log("No local config to sync. Use 'nusuk config set' first.");
    return;
  }
  const workerUrl = local["worker.url"] || CONFIG_KEYS["worker.url"];
  const apiKey = local["worker.apiKey"] || process.env.WORKER_API_KEY || "";
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(`${workerUrl}/api/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ settings: local }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sync failed (${res.status}): ${body.slice(0, 200)}`);
  }
  console.log(`✓ synced ${keys.length} setting(s) to ${workerUrl}`);
}
function help(topic = "") {
  if (topic === "captcha") {
    console.log(`
Usage: nusuk captcha <action> [options]

Actions:
  pull                  Pull one CAPTCHA
  watch                 Refresh continuously in the foreground
  start                 Start a silent background refresher
  status                Show background refresher status
  stop                  Stop the background refresher
  set [token]           Save a CAPTCHA token
  show                  Show the saved token
  solve [--v3]          Solve via CapSolver (default) or CapMonster (--capmonster)
  balance               Check solver account balance (--capmonster for CapMonster)

Options:
  --type <type>         visa, login, or general (default: visa)
  --entity <id>         Entity ID
  --interval <duration> Poll interval, for example 5s or 1m
  --output <path>       CAPTCHA output file
  --fallback            Allow fallback to another CAPTCHA type
  --quiet               Suppress routine output
`);
    return;
  }

  console.log(`
Toque — Nusuk command line

Usage: nusuk <command> [options]
       nusuk                    Open the guided menu

Common tasks:
  init                  Create ignored local config files after a fresh clone
  login                 Install the latest user credentials
  whoami                Show current session entity info from JWT
  login-auto            Auto-login via captcha solver and save JWT
  verify-login          Verify OTP after auto-login (requires transaction ID)
  refresh-token         Refresh the JWT using the stored refresh token or saved profile
  logout                Clear local auth, captcha, and entity state
  pull                  Refresh auth, entity, and CAPTCHA files
  info                  Show dashboard company information
  send <group-id>       Send a visa request
  set-group-id <id>     Store a default group ID for future sends
  request <path>        Send a custom API request
  api <name>            Run a saved request from the catalog
  groups list           Show group names and IDs
  schedule              Schedule a request
  workflow              Manage Cloudflare Workflow instances (status, terminate)
  config                Memorized & configurable options (get, set, list, sync)
  sync-time             Sync system clock to accurate network time
  bench [count]         Measure request latency

CAPTCHA:
  captcha <action>      Pull, monitor, set, show, or solve CAPTCHA

Help:
  help [command]        Show command help

Examples:
  nusuk login
  nusuk whoami
  nusuk login-auto --username user@email.com --password pass123
  nusuk verify-login --transaction-id <id> --otp 1234
  nusuk refresh-token
  nusuk info
  nusuk send 12345
  nusuk api verify-subscription
  nusuk api list
  nusuk groups list
  nusuk captcha start --type visa --interval 5s --quiet
  nusuk help captcha
`);
}

async function guidedMenu() {
  if (!canPrompt()) {
    help();
    return;
  }
  console.log(`
What would you like to do?

  1. Log in / install credentials
  2. Refresh auth and CAPTCHA
  3. Show company information
  4. Send a visa request
  5. Manage CAPTCHA
  6. Send a custom request
  7. Verify subscription status
  8. Schedule a request
  9. Benchmark latency
  0. Exit
`);
  const selection = await ask("Select: ");
  switch (selection) {
    case "1": return cmdLogin([]);
    case "2": return cmdPull([]);
    case "3": return cmdApi(["company-info"]);
    case "4": {
      return cmdSendVisa([]);
    }
    case "5": help("captcha"); return;
    case "6": {
      const path = await ask("API path: ");
      if (!path) throw new Error("API path is required");
      return cmdReq([path]);
    }
    case "7": return cmdApi(["verify-subscription"]);
    case "8": {
      const target = await ask("Target time (HH:MM:SS): ");
      if (!target) throw new Error("Target time is required");
      return cmdSchedule(["--target", target]);
    }
    case "9": return cmdBench([]);
    case "0": case "": return;
    default: throw new Error("Invalid selection. Run `nusuk` again and choose 0-9");
  }
}

async function main() {
  const [, , cmd, ...args] = process.argv;

  if (!cmd) return guidedMenu();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    help(args[0] || "");
    return;
  }
  if (cmd === "captcha" && (args.includes("--help") || args.includes("-h"))) {
    help("captcha");
    return;
  }

  switch (cmd) {
    case "bench":
      await cmdBench(args);
      break;
    case "request":
      await cmdReq(args);
      break;
    case "api":
      await cmdApi(args);
      break;
    case "groups":
      await cmdGroups(args);
      break;
    case "init":
      await cmdInit(args);
      break;
    case "logout":
    case "clear":
      await cmdLogout(args);
      break;
    case "schedule":
      await cmdSchedule(args);
      break;
    case "set-group-id":
      await cmdSetGroupId(args);
      break;
    case "send":
    case "send-visa":
      await cmdSendVisa(args);
      break;
    case "sync-time":
      await cmdSyncTime(args);
      break;
    case "captcha-set":
      await cmdCaptchaSet(args);
      break;
    case "captcha-show":
      await cmdCaptchaShow();
      break;
    case "captcha-solve":
      await cmdCaptchaSolve(args);
      break;
    case "captcha-balance":
      await cmdCaptchaBalance(args);
      break;
    case "captcha":
      await cmdCaptcha(args);
      break;
    case "pull":
      await cmdPull(args);
      break;
    case "info":
      await cmdApi(["company-info", ...args]);
      break;
    case "login":
      await cmdLogin(args);
      break;
    case "whoami":
      await cmdWhoami(args);
      break;
    case "login-auto":
    case "autologin":
      await cmdAutoLogin(args);
      break;
    case "verify-login":
      await cmdVerifyLogin(args);
      break;
    case "refresh-token":
    case "refresh":
      await cmdRefreshToken(args);
      break;
    case "workflow":
      await cmdWorkflow(args);
      break;
    case "config":
      await cmdConfig(args);
      break;
    case "help":
      help(args[0] || "");
      break;
    case "--help":
    case "-h":
      help();
      break;
    default:
      throw new Error(`Unknown command: ${cmd}. Run "nusuk help" for usage`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  if (process.env.NUSUK_DEBUG === "1") console.error(err.stack);
  process.exitCode = 1;
});
