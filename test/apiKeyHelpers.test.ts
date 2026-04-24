import { describe, it, expect } from "vitest";
import {
  allocateUniqueKeyEmail,
  generateApiKeySecret,
  hashApiKey,
  validateApiKeyFormat,
  ALLOWED_API_KEY_SCOPES,
} from "../src/lib/apiKey";

describe("API key helpers", () => {
  it("generates a valid API key secret with prefix and dot separator", () => {
    const { secret, keyPrefix } = generateApiKeySecret();

    expect(secret).toContain(".");
    expect(secret.startsWith(`${keyPrefix}.`)).toBe(true);
    expect(validateApiKeyFormat(secret)).toBe(true);
    expect(keyPrefix).toMatch(/^amethyst_live_[A-Za-z0-9]{20}$/);
  });

  it("rejects invalid API key formats", () => {
    expect(validateApiKeyFormat("bad-key-with spaces")).toBe(false);
    expect(validateApiKeyFormat("short")).toBe(false);
    expect(validateApiKeyFormat("amethyst_live_123.invalidsuffix")).toBe(false);
  });

  it("accepts legacy raw API key formats for backwards compatibility", () => {
    expect(validateApiKeyFormat("abcdef1234567890"))
      .toBe(true);
    expect(validateApiKeyFormat("legacy_key-12345678"))
      .toBe(true);
  });

  it("hashes API keys deterministically and produces a hex digest", () => {
    const secret = generateApiKeySecret().secret;
    const hashA = hashApiKey(secret);
    const hashB = hashApiKey(secret);

    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes expected scope names", () => {
    expect(ALLOWED_API_KEY_SCOPES).toEqual([
      "valuation",
      "catalog",
      "scarcity",
      "simulation",
      "signals",
    ]);
  });

  it("allocateUniqueKeyEmail accepts valid email or returns unique synthetic", () => {
    expect(allocateUniqueKeyEmail("  Foo@Bar.COM  ")).toBe("foo@bar.com");
    const a = allocateUniqueKeyEmail(null);
    const b = allocateUniqueKeyEmail(undefined);
    expect(a).toMatch(/^issued\+[a-f0-9]{32}@amethyst-api\.local$/);
    expect(b).toMatch(/^issued\+[a-f0-9]{32}@amethyst-api\.local$/);
    expect(a).not.toBe(b);
  });
});
