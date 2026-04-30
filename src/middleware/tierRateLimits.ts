import type { ApiKeyTier } from "../models/ApiKey";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeTier(t: string | undefined): ApiKeyTier {
  if (t === "premium" || t === "standard" || t === "free") return t;
  return "free";
}

/**
 * Tier-aware valuation request ceiling per rolling window.
 * Standard tier uses `RATE_LIMIT_VALUATION_MAX` as baseline; free is lower, premium higher.
 */
export function valuationLimitForTier(tier: string | undefined): number {
  const standard = parsePositiveInt(
    process.env.RATE_LIMIT_VALUATION_MAX,
    300
  );
  const free = parsePositiveInt(
    process.env.RATE_LIMIT_VALUATION_MAX_FREE,
    Math.max(50, Math.floor(standard * 0.4))
  );
  const premium = parsePositiveInt(
    process.env.RATE_LIMIT_VALUATION_MAX_PREMIUM,
    standard * 3
  );
  switch (normalizeTier(tier)) {
    case "premium":
      return premium;
    case "standard":
      return standard;
    default:
      return free;
  }
}

/**
 * Tier-aware catalog batch ceiling per rolling window.
 */
export function catalogLimitForTier(tier: string | undefined): number {
  const standard = parsePositiveInt(
    process.env.RATE_LIMIT_CATALOG_MAX,
    1200
  );
  const free = parsePositiveInt(
    process.env.RATE_LIMIT_CATALOG_MAX_FREE,
    Math.max(200, Math.floor(standard * 0.4))
  );
  const premium = parsePositiveInt(
    process.env.RATE_LIMIT_CATALOG_MAX_PREMIUM,
    standard * 3
  );
  switch (normalizeTier(tier)) {
    case "premium":
      return premium;
    case "standard":
      return standard;
    default:
      return free;
  }
}
