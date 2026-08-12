/**
 * Shared config schema for the toque platform.
 *
 * Defines the typed configuration that can be loaded from:
 *   1. CLI flags (highest precedence)
 *   2. Environment variables
 *   3. D1-stored settings (app_db `settings` table)
 *   4. Defaults (lowest precedence)
 *
 * Importable by both TypeScript (toqueui) and JavaScript (toque-worker).
 */

// ─── Config schema ──────────────────────────────────────────────────

export interface ToquePlatformConfig {
  /** Autha-worker connection */
  autha: {
    /** Worker URL (direct mode) or proxy URL (container mode) */
    endpoint: string;
    /** Bearer token for autha-worker API (not needed in proxy mode) */
    apiToken: string;
    /** Use the Worker's /autha service-binding proxy instead of direct HTTP */
    proxyMode: boolean;
  };

  /** Toque Worker connection */
  worker: {
    /** Public Worker URL */
    url: string;
    /** X-API-Key for the Worker gateway */
    apiKey: string;
    /** Cloudflare Access JWT (alternative to API key) */
    jwt: string;
    /** Auth mode */
    authMode: "api-key" | "jwt";
  };

  /** Nusuk platform */
  nusuk: {
    /** Base URL */
    baseUrl: string;
    /** Default entity ID */
    activeEntityId: string;
    /** Default entity type ID */
    activeEntityTypeId: string;
    /** System user ID (for autha-worker queries) */
    systemUserId: string;
  };

  /** Captcha solver */
  captcha: {
    /** Default provider */
    provider: "capmonster" | "capsolver";
    /** CapMonster API key */
    capmonsterApiKey: string;
    /** CapSolver API key */
    capsolverApiKey: string;
    /** reCAPTCHA site key */
    siteKey: string;
    /** Page URL where captcha appears */
    pageUrl: string;
    /** Page action for reCAPTCHA v3 */
    pageAction: string;
    /** Minimum score for v3 */
    minScore: number;
  };

  /** Container */
  container: {
    /** Max instances for auto-scaling */
    maxInstances: number;
    /** Sleep after idle (duration string, e.g. "60m") */
    sleepAfter: string;
    /** Instance type */
    instanceType: string;
    /** Allowed regions */
    regions: string[];
  };

  /** Local file paths (for CLI mode) */
  paths: {
    auth: string;
    captcha: string;
    entity: string;
    profile: string;
  };
}

// ─── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_CONFIG: ToquePlatformConfig = {
  autha: {
    endpoint: "https://autha-worker.decloud.workers.dev",
    apiToken: "",
    proxyMode: false,
  },
  worker: {
    url: "https://toque.decloud.workers.dev",
    apiKey: "",
    jwt: "",
    authMode: "api-key",
  },
  nusuk: {
    baseUrl: "https://masar.nusuk.sa",
    activeEntityId: "",
    activeEntityTypeId: "",
    systemUserId: "default",
  },
  captcha: {
    provider: "capsolver",
    capmonsterApiKey: "",
    capsolverApiKey: "",
    siteKey: "6Le-3OwpAAAAAARztuPscqBNbpEY3okMkd7dCoyx",
    pageUrl: "https://masar.nusuk.sa/umrah/mutamer-group/group-list",
    pageAction: "submit",
    minScore: 0.7,
  },
  container: {
    maxInstances: 3,
    sleepAfter: "60m",
    instanceType: "standard-4",
    regions: ["WEUR"],
  },
  paths: {
    auth: "auth.json",
    captcha: "captcha.json",
    entity: "entity.json",
    profile: "profile.json",
  },
};

// ─── Config precedence ──────────────────────────────────────────────

export type ConfigSource = "cli" | "env" | "d1" | "default";

export interface ConfigEntry<T = unknown> {
  value: T;
  source: ConfigSource;
}

/**
 * Merge configs by precedence: cli > env > d1 > default.
 * Each override is applied in order; the first non-undefined value wins.
 */
export function resolveConfig(
  ...layers: Partial<ToquePlatformConfig>[]
): ToquePlatformConfig {
  return layers.reduce<ToquePlatformConfig>(
    (acc, layer) => ({
      autha: { ...acc.autha, ...(layer.autha || {}) },
      worker: { ...acc.worker, ...(layer.worker || {}) },
      nusuk: { ...acc.nusuk, ...(layer.nusuk || {}) },
      captcha: { ...acc.captcha, ...(layer.captcha || {}) },
      container: { ...acc.container, ...(layer.container || {}) },
      paths: { ...acc.paths, ...(layer.paths || {}) },
    }),
    DEFAULT_CONFIG,
  );
}
