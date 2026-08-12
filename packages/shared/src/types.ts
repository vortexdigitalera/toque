/**
 * Shared types for the toque platform.
 *
 * These types define the API contract between:
 *   - toque-worker (the Cloudflare Worker + Container backend)
 *   - toqueui (the Next.js dashboard)
 *   - autha-worker (the D1-backed token store)
 *
 * Importable by both TypeScript (toqueui) and JavaScript (toque-worker via JSDoc).
 */

// ─── Generic API envelope ─────────────────────────────────────────────

export type FailureCategory =
  | "timeout"
  | "invalid_auth"
  | "backend_down"
  | "network"
  | "client_error"
  | "unknown";

export interface RecoveryHint {
  category: FailureCategory;
  title: string;
  hint: string;
  action?: string;
}

export interface ToqueResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  latencyMs: number;
  cliCommand: string;
  attempts?: number;
  failureCategory?: FailureCategory;
  recoveryHint?: RecoveryHint;
}

// ─── Timing ───────────────────────────────────────────────────────────

export interface RequestTiming {
  total: number;
  ttfb: number;
}

// ─── Health ───────────────────────────────────────────────────────────

export interface HealthResponse {
  ok: boolean;
}

// ─── Auth ─────────────────────────────────────────────────────────────

export type AuthMode = "api-key" | "jwt";

export interface ToqueConfig {
  baseUrl: string;
  apiKey: string;
  jwtToken: string;
  authMode: AuthMode;
}

export type AuthInfoResponse = Record<string, unknown>;

export interface AuthRefreshResponse {
  ok: boolean;
  status: number;
  data: unknown;
  saved: boolean;
  method: string;
  timing?: RequestTiming;
}

export interface LoginPayload {
  username: string;
  password: string;
  provider?: "capmonster" | "capsolver";
  xChannel?: string;
  trustedDeviceToken?: string;
  siteKey?: string;
  pageUrl?: string;
  captchaVersion?: number;
  captchaType?: string;
  enterprise?: boolean;
}

export interface LoginResponse {
  ok: boolean;
  status: number;
  data: unknown;
  captchaToken?: string;
  saved: boolean;
  otpRequired: boolean;
  transactionId?: string;
  intermediateToken?: string;
  timing?: RequestTiming;
}

export interface VerifyLoginResponse {
  ok: boolean;
  status: number;
  data: unknown;
  saved: boolean;
  timing?: RequestTiming;
}

// ─── Groups ──────────────────────────────────────────────────────────

export interface Group {
  id: string;
  name: string;
}

export interface GroupsListResponse {
  groups: Group[];
  raw?: unknown;
}

// ─── Pull ────────────────────────────────────────────────────────────

export interface PullSaved {
  auth: boolean;
  captcha: boolean;
  entityId: string | null;
  systemUserId: string | null;
}

export interface PullResponse {
  ok: boolean;
  context: unknown;
  saved: PullSaved;
}

// ─── Send Visa ───────────────────────────────────────────────────────

export interface SendVisaResponse {
  ok: boolean;
  status: number;
  data: unknown;
  timing?: RequestTiming;
}

export interface SendVisaPayload {
  groupId: string;
  payload?: Record<string, unknown>;
  captchaToken?: string;
  captchaType?: string;
}

// ─── Schedule (Cloudflare Workflow) ─────────────────────────────────

export type WorkflowStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled";

export interface ScheduledWorkflow {
  id: string; // instanceId
  groupId: string;
  groupName?: string;
  targetTime: string;
  status: WorkflowStatus;
  pullBefore: boolean;
  captcha: boolean;
  captchaType: string;
  createdAt: string;
}

export interface ScheduleCreatePayload {
  targetTime: string;
  groupId: string;
  captcha?: boolean;
  captchaType?: string;
  payload?: Record<string, unknown>;
  pullBefore?: boolean;
}

export interface ScheduleCreateResponse {
  ok: boolean;
  instanceId: string;
  targetTime: string;
  groupId: string;
}

export interface ScheduleStatusResponse {
  ok: boolean;
  instanceId: string;
  status: unknown;
}

// ─── CAPTCHA ─────────────────────────────────────────────────────────

export type CaptchaProvider = "capmonster" | "capsolver";

export type CaptchaType =
  | "recaptcha"
  | "turnstile"
  | "visa"
  | "login"
  | "general";

export interface CaptchaSolveParams {
  provider?: CaptchaProvider;
  version?: 2 | 3;
  captchaType?: CaptchaType;
  enterprise?: boolean;
  siteKey?: string;
  pageUrl?: string;
  pageAction?: string;
}

export interface CaptchaSolveResponse {
  ok: boolean;
  token: string;
  provider: string;
}

export interface CaptchaBalanceResponse {
  ok: boolean;
  balance: number;
  provider: string;
}

// ─── Cmd (CLI runner) ───────────────────────────────────────────────

export interface CmdResponse {
  ok: boolean;
  command: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  status?: unknown;
}

// ─── Autha worker ────────────────────────────────────────────────────

export interface AuthaEntitiesResponse {
  ok: boolean;
  entities: string[];
  count: number;
}

export interface AuthaHealthResponse {
  ok: boolean;
  service?: string;
  version?: string;
}

// ─── Auth context (from autha-worker D1) ────────────────────────────

export interface AuthContext {
  entityId: string;
  entityTypeId?: string;
  auth: {
    token: string;
    timestamp: number;
    tokenType?: number;
  };
  captcha: {
    visa?: string;
    login?: string;
    general?: string;
    latest?: string;
    timestamp?: number;
  };
}

// ─── User profiles & audit (app_db, replaces Supabase) ──────────────

export type UserRole = "super_admin" | "admin" | "operator" | "viewer";

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  avatarUrl?: string;
  role: UserRole;
  suspendedAt?: string | null;
  suspendedBy?: string | null;
  suspensionReason?: string | null;
  permissions: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  userId?: string | null;
  userEmail?: string | null;
  action: string;
  panel?: string | null;
  details: Record<string, unknown>;
  ipAddress?: string | null;
  createdAt: string;
}

// ─── Settings (D1-backed config) ────────────────────────────────────

export interface Setting {
  key: string;
  value: string;
  updatedAt: string;
}
