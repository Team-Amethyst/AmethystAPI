import crypto from "crypto";
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

const DEFAULT_API_KEY_PEPPER = "amethyst_dev_pepper_2026";

function resolveApiKeyPepper(): string {
  return process.env.API_KEY_PEPPER || process.env.APP_SECRET || DEFAULT_API_KEY_PEPPER;
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
