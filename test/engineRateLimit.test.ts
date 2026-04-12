import { afterEach, describe, expect, it, vi } from "vitest";
import { isEngineRateLimitingEnabled } from "../src/middleware/engineRateLimit";

describe("isEngineRateLimitingEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false when RATE_LIMIT_ENABLED is off", () => {
    vi.stubEnv("RATE_LIMIT_ENABLED", "0");
    vi.stubEnv("VITEST", "true");
    expect(isEngineRateLimitingEnabled()).toBe(false);
  });

  it("is true when RATE_LIMIT_ENABLED forces on under Vitest", () => {
    vi.stubEnv("RATE_LIMIT_ENABLED", "1");
    vi.stubEnv("VITEST", "true");
    expect(isEngineRateLimitingEnabled()).toBe(true);
  });

  it("is false under Vitest when RATE_LIMIT_ENABLED unset", () => {
    vi.stubEnv("VITEST", "true");
    delete process.env.RATE_LIMIT_ENABLED;
    expect(isEngineRateLimitingEnabled()).toBe(false);
  });
});
