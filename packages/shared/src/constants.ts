/**
 * Shared constants for the toque platform.
 *
 * Single source of truth for values used across toque-worker, toqueui,
 * and autha-worker.
 */

// ─── Nusuk platform ──────────────────────────────────────────────────

export const NUSUK_BASE_URL = "https://masar.nusuk.sa";

export const NUSUK_LOGIN_URL = "https://masar.nusuk.sa/pub/login";

export const NUSUK_GROUP_LIST_URL =
  "https://masar.nusuk.sa/umrah/mutamer-group/group-list";

// ─── reCAPTCHA ───────────────────────────────────────────────────────

export const DEFAULT_RECAPTCHA_SITE_KEY =
  "6Le-3OwpAAAAAARztuPscqBNbpEY3okMkd7dCoyx";

export const DEFAULT_PAGE_ACTION = "submit";

export const DEFAULT_MIN_SCORE = 0.7;

// ─── Captcha types ──────────────────────────────────────────────────

export const CAPTCHA_TYPES = ["visa", "login", "general"] as const;

// ─── Token types (Nusuk JWT `tokenType` claim) ──────────────────────

export const TOKEN_TYPE = {
  TEMP: 2, // Issued after /login when trustedDevice=false — no entity claims
  AUTH: 3, // Full auth token with entity claims (after verifyLogin or trustedDevice=true)
  REFRESH: 4, // Used by /refreshToken
  USER: 5, // User token — no entity claims
} as const;

// ─── API endpoints ───────────────────────────────────────────────────

export const ENDPOINTS = {
  // Worker (gateway)
  HEALTH: "/health",
  HELP: "/help",
  SCHEDULE_WORKFLOW: "/schedule/workflow",
  SCHEDULE_WORKFLOW_STATUS: "/schedule/workflow/status",
  SCHEDULE_WORKFLOW_TERMINATE: "/schedule/workflow/terminate",
  AUTHA: "/autha",

  // Container (proxied via Worker)
  PULL: "/pull",
  INFO: "/info",
  SEND: "/send",
  GROUPS: "/groups",
  LOGIN: "/login",
  VERIFY_LOGIN: "/verify-login",
  REFRESH_TOKEN: "/refresh-token",
  CAPTCHA_SOLVE: "/captcha/solve",
  CAPTCHA_BALANCE: "/captcha/balance",
  SCHEDULE: "/schedule",
  CMD: "/cmd",
  CMD_LIST: "/cmd/list",
  API_LIST: "/api-list",

  // Autha-worker
  AUTHA_HEALTH: "/autha/health",
  AUTHA_ENTITIES: "/autha/entities",
  AUTHA_STATS: "/autha/stats",
} as const;

// ─── Autha-worker D1 ────────────────────────────────────────────────

export const DEFAULT_AUTHA_WORKER_URL =
  "https://autha-worker.decloud.workers.dev";

// ─── Toque Worker ───────────────────────────────────────────────────

export const DEFAULT_TOQUE_WORKER_URL = "https://toque.decloud.workers.dev";

// ─── RBAC ───────────────────────────────────────────────────────────

export const USER_ROLES = [
  "super_admin",
  "admin",
  "operator",
  "viewer",
] as const;

export const PANEL_PERMISSIONS = {
  dashboard: ["super_admin", "admin", "operator", "viewer"],
  pulling: ["super_admin", "admin", "operator", "viewer"],
  network: ["super_admin", "admin", "operator", "viewer"],
  "api-builder": ["super_admin", "admin", "operator", "viewer"],
  "send-visa": ["super_admin", "admin", "operator"],
  schedule: ["super_admin", "admin", "operator"],
  captcha: ["super_admin", "admin", "operator"],
  benchmarking: ["super_admin", "admin"],
  "team-management": ["super_admin", "admin"],
} as const;

export type Panel = keyof typeof PANEL_PERMISSIONS;
