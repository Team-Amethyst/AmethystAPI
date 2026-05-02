import crypto from "crypto";
import { env } from "../config/env";
import { ApiKeyTier } from "../models/ApiKey";

export const API_KEY_PREFIX = "amethyst_live";
export const API_KEY_SECRET_PATTERN = new RegExp(`^${API_KEY_PREFIX}_[A-Za-z0-9]{20}.[A-Za-z0-9]{48}$`);
export const API_KEY_LEGACY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const ALLOWED_API_KEY_TIERS: ApiKeyTier[] = ["free", "standard", "premium"];
export const ALLOWED_API_KEY_SCOPES = [
  "valuation",
  "catalog",
  "scarcity",
  "simulation",
  "signals",
] as const;
export type ApiKeyScope = (typeof ALLOWED_API_KEY_SCOPES)[number];

function resolveApiKeyPepper(): string {
  return env.apiKeyPepper;
}

export function hashApiKey(secret: string): string {
  return crypto
    .createHmac("sha256", resolveApiKeyPepper())
    .update(secret)
    .digest("hex");
}

export function generateApiKeySecret(): { secret: string; keyPrefix: string } {
  const prefix = crypto.randomBytes(10).toString("hex");
  const secretSuffix = crypto.randomBytes(24).toString("hex");
  const keyPrefix = `${API_KEY_PREFIX}_${prefix}`;
  return {
    secret: `${keyPrefix}.${secretSuffix}`,
    keyPrefix,
  };
}

export function validateApiKeyFormat(rawKey: string): boolean {
  return API_KEY_SECRET_PATTERN.test(rawKey) || API_KEY_LEGACY_PATTERN.test(rawKey);
}

export function normalizeScopes(scopes: unknown): ApiKeyScope[] {
  if (!Array.isArray(scopes)) {
    return [];
  }

  return scopes
    .filter((scope): scope is string => typeof scope === "string")
    .map((scope) => scope.trim())
    .filter((scope): scope is ApiKeyScope => ALLOWED_API_KEY_SCOPES.includes(scope as ApiKeyScope));
}

/**
 * Legacy Atlas clusters sometimes define a unique index on `email`. Hashed keys omit email unless
 * set, which can make every insert collide on `null`. Use a unique synthetic address when none is
 * supplied, or a normalized address when the caller provides one.
 */
export function allocateUniqueKeyEmail(provided?: string | null): string {
  const p = typeof provided === "string" ? provided.trim() : "";
  if (p.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) {
    return p.toLowerCase();
  }
  return `issued+${crypto.randomBytes(16).toString("hex")}@amethyst-api.local`;
}
