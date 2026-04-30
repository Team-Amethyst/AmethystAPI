import { describe, expect, it, vi } from "vitest";
import {
  catalogLimitForTier,
  valuationLimitForTier,
} from "../src/middleware/tierRateLimits";

describe("tierRateLimits", () => {
  it("uses lower valuation ceiling for free than premium", () => {
    vi.stubEnv("RATE_LIMIT_VALUATION_MAX", "300");
    vi.stubEnv("RATE_LIMIT_VALUATION_MAX_FREE", "100");
    vi.stubEnv("RATE_LIMIT_VALUATION_MAX_PREMIUM", "900");
    expect(valuationLimitForTier("free")).toBe(100);
    expect(valuationLimitForTier("standard")).toBe(300);
    expect(valuationLimitForTier("premium")).toBe(900);
    vi.unstubAllEnvs();
  });

  it("defaults unknown tier to free-style limits", () => {
    vi.stubEnv("RATE_LIMIT_VALUATION_MAX", "250");
    vi.stubEnv("RATE_LIMIT_VALUATION_MAX_FREE", "80");
    expect(valuationLimitForTier(undefined)).toBe(80);
    expect(valuationLimitForTier("enterprise")).toBe(80);
    vi.unstubAllEnvs();
  });

  it("scales catalog limits by tier", () => {
    vi.stubEnv("RATE_LIMIT_CATALOG_MAX", "1000");
    vi.stubEnv("RATE_LIMIT_CATALOG_MAX_FREE", "250");
    vi.stubEnv("RATE_LIMIT_CATALOG_MAX_PREMIUM", "3000");
    expect(catalogLimitForTier("free")).toBe(250);
    expect(catalogLimitForTier("standard")).toBe(1000);
    expect(catalogLimitForTier("premium")).toBe(3000);
    vi.unstubAllEnvs();
  });
});
