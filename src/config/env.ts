/**
 * Central env snapshot (dotenv loaded first). Use for stable configuration.
 * Runtime toggles that integration/unit tests mutate (`RATE_LIMIT_ENABLED`,
 * `KEY_ISSUANCE_ENABLED`, …) stay as direct `process.env` reads in those modules.
 */
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

function trim(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const t = s.trim();
  return t.length ? t : undefined;
}

function parseIpAllowlist(raw: string | undefined): string[] {
  const t = trim(raw);
  if (!t) return [];
  return t
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const Schema = z.object({
  NODE_ENV: z.string().optional(),
  VITEST: z.string().optional(),
  FORCE_SECURE_COOKIES: z.string().optional(),
  MONGO_URI: z.string().optional(),
  PORT: z.preprocess(
    (v) => (v == null || v === "" ? undefined : Number(v)),
    z.number().int().positive().max(65535).optional()
  ),
  CORS_ORIGIN: z.string().optional(),
  REDIS_URL: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  ENGINE_IP_ALLOWLIST: z.string().optional(),
  VALUATION_AGGREGATE_LOG: z.string().optional(),
  HEALTHCHECK_REDIS: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
  API_KEY_PEPPER: z.string().optional(),
  APP_SECRET: z.string().optional(),
  PORTAL_SESSION_SECRET: z.string().optional(),
  RATE_LIMIT_VALUATION_WINDOW_MS: z.string().optional(),
  RATE_LIMIT_CATALOG_WINDOW_MS: z.string().optional(),
  VALUATION_MODEL_VERSION: z.string().optional(),
  GITHUB_SHA: z.string().optional(),
  GIT_COMMIT: z.string().optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
});

const raw = Schema.safeParse(process.env);
if (!raw.success) {
  throw new Error(`Invalid environment: ${raw.error.message}`);
}

const e = raw.data;
const engineIpAllowlist = parseIpAllowlist(e.ENGINE_IP_ALLOWLIST);
const allowlistActive = engineIpAllowlist.length > 0;
const trustProxyFirstHop = allowlistActive || trim(e.TRUST_PROXY) === "1";

const DEFAULT_PEPPER = "amethyst_dev_pepper_2026";

export const env = {
  nodeEnv: trim(e.NODE_ENV),
  isVitest: e.VITEST === "true",
  forceSecureCookies: trim(e.FORCE_SECURE_COOKIES) === "1",
  mongoUri: trim(e.MONGO_URI),
  port: e.PORT ?? 3001,
  corsOrigin: trim(e.CORS_ORIGIN) ?? "http://localhost:5173",
  redisUrl: trim(e.REDIS_URL) ?? "redis://localhost:6379",
  trustProxyFirstHop,
  /** Parsed allowlist entries; empty array when disabled. */
  engineIpAllowlist,
  engineIpAllowlistEnabled: allowlistActive,
  valuationAggregateLog: trim(e.VALUATION_AGGREGATE_LOG) === "1",
  healthcheckRedisEnabled: trim(e.HEALTHCHECK_REDIS) !== "0",
  logLevel: trim(e.LOG_LEVEL),
  apiKeyPepper: trim(e.API_KEY_PEPPER) || trim(e.APP_SECRET) || DEFAULT_PEPPER,
  portalSessionSecret:
    trim(e.PORTAL_SESSION_SECRET) ||
    trim(e.APP_SECRET) ||
    trim(e.API_KEY_PEPPER) ||
    "amethyst_portal_dev_secret_2026",
  /** Rolling-window sizes only; per-tier ceilings stay live `process.env` in tierRateLimits (test stubs). */
  rateLimit: {
    valuationWindowMs: parsePositiveInt(e.RATE_LIMIT_VALUATION_WINDOW_MS, 60_000),
    catalogWindowMs: parsePositiveInt(e.RATE_LIMIT_CATALOG_WINDOW_MS, 60_000),
  },
  valuationModelVersion: trim(e.VALUATION_MODEL_VERSION),
  gitSha:
    trim(e.GITHUB_SHA) ||
    trim(e.VERCEL_GIT_COMMIT_SHA) ||
    trim(e.GIT_COMMIT) ||
    null,
} as const;
