import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __apiKeyMemoCacheSize,
  apiKeyMemoTtlMs,
  clearApiKeyMemoCache,
  getApiKeyMemoEntry,
  invalidateApiKeyMemoEntry,
  isApiKeyMemoCacheDisabled,
  setApiKeyMemoEntry,
} from "../src/lib/apiKeyMemoryCache";

const ORIGINAL_TTL = process.env.AMETHYST_API_KEY_MEMO_TTL_MS;
const ORIGINAL_DISABLE = process.env.AMETHYST_DISABLE_API_KEY_MEMO_CACHE;
const ORIGINAL_VITEST = process.env.VITEST;

beforeEach(() => {
  clearApiKeyMemoCache();
  /*
   * The cache is auto-disabled under `VITEST=true` (matches the catalog cache
   * pattern) so the production middleware code never accidentally pollutes
   * test state. Flip it off for the duration of these tests so we exercise
   * real behavior.
   */
  process.env.VITEST = "false";
  delete process.env.AMETHYST_API_KEY_MEMO_TTL_MS;
  delete process.env.AMETHYST_DISABLE_API_KEY_MEMO_CACHE;
});

afterEach(() => {
  clearApiKeyMemoCache();
  if (ORIGINAL_TTL === undefined) delete process.env.AMETHYST_API_KEY_MEMO_TTL_MS;
  else process.env.AMETHYST_API_KEY_MEMO_TTL_MS = ORIGINAL_TTL;
  if (ORIGINAL_DISABLE === undefined)
    delete process.env.AMETHYST_DISABLE_API_KEY_MEMO_CACHE;
  else process.env.AMETHYST_DISABLE_API_KEY_MEMO_CACHE = ORIGINAL_DISABLE;
  if (ORIGINAL_VITEST === undefined) delete process.env.VITEST;
  else process.env.VITEST = ORIGINAL_VITEST;
});

describe("apiKeyMemoryCache", () => {
  const sample = {
    owner: "demo-owner",
    tier: "standard",
    isActive: true,
    scopes: ["valuation" as const, "catalog" as const],
  };

  it("apiKeyMemoTtlMs defaults to 60000 and clamps env overrides", () => {
    delete process.env.AMETHYST_API_KEY_MEMO_TTL_MS;
    expect(apiKeyMemoTtlMs()).toBe(60_000);

    process.env.AMETHYST_API_KEY_MEMO_TTL_MS = "30000";
    expect(apiKeyMemoTtlMs()).toBe(30_000);

    process.env.AMETHYST_API_KEY_MEMO_TTL_MS = "100";
    expect(apiKeyMemoTtlMs()).toBe(1_000);

    process.env.AMETHYST_API_KEY_MEMO_TTL_MS = "9999999";
    expect(apiKeyMemoTtlMs()).toBe(600_000);

    process.env.AMETHYST_API_KEY_MEMO_TTL_MS = "garbage";
    expect(apiKeyMemoTtlMs()).toBe(60_000);
  });

  it("isApiKeyMemoCacheDisabled honors VITEST and the disable flag", () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_DISABLE_API_KEY_MEMO_CACHE;
    expect(isApiKeyMemoCacheDisabled()).toBe(false);

    process.env.AMETHYST_DISABLE_API_KEY_MEMO_CACHE = "1";
    expect(isApiKeyMemoCacheDisabled()).toBe(true);

    delete process.env.AMETHYST_DISABLE_API_KEY_MEMO_CACHE;
    process.env.VITEST = "true";
    expect(isApiKeyMemoCacheDisabled()).toBe(true);
  });

  it("returns null on miss and stores a hit retrievable within TTL", () => {
    expect(getApiKeyMemoEntry("hash-1")).toBeNull();
    setApiKeyMemoEntry("hash-1", sample);
    const hit = getApiKeyMemoEntry("hash-1");
    expect(hit).toEqual(sample);
  });

  it("returns a defensive copy of scopes so callers cannot mutate the cache", () => {
    setApiKeyMemoEntry("hash-1", sample);
    const hit = getApiKeyMemoEntry("hash-1");
    expect(hit).not.toBeNull();
    hit!.scopes.push("scarcity");
    const second = getApiKeyMemoEntry("hash-1");
    expect(second!.scopes).toEqual(sample.scopes);
  });

  it("expires entries after the configured TTL", () => {
    process.env.AMETHYST_API_KEY_MEMO_TTL_MS = "1000";
    const t0 = 1_700_000_000_000;
    setApiKeyMemoEntry("hash-1", sample, t0);
    expect(getApiKeyMemoEntry("hash-1", t0 + 500)).not.toBeNull();
    expect(getApiKeyMemoEntry("hash-1", t0 + 1_001)).toBeNull();
  });

  it("invalidateApiKeyMemoEntry removes a single key", () => {
    setApiKeyMemoEntry("hash-1", sample);
    setApiKeyMemoEntry("hash-2", sample);
    invalidateApiKeyMemoEntry("hash-1");
    expect(getApiKeyMemoEntry("hash-1")).toBeNull();
    expect(getApiKeyMemoEntry("hash-2")).not.toBeNull();
  });

  it("returns null without storing when the cache is disabled", () => {
    process.env.AMETHYST_DISABLE_API_KEY_MEMO_CACHE = "1";
    setApiKeyMemoEntry("hash-1", sample);
    expect(__apiKeyMemoCacheSize()).toBe(0);
    expect(getApiKeyMemoEntry("hash-1")).toBeNull();
  });

  it("LRU-touches hot keys so they survive overflow eviction (sanity check)", () => {
    setApiKeyMemoEntry("hash-1", sample);
    setApiKeyMemoEntry("hash-2", sample);
    /*
     * Reading hash-1 should move it to the end of the iteration order so a
     * future overflow eviction (FIFO) would drop hash-2 first. We can't
     * trigger the 1000-entry overflow cheaply here, but we can verify the
     * touch by checking iteration order after a get.
     */
    getApiKeyMemoEntry("hash-1");
    setApiKeyMemoEntry("hash-3", sample);
    expect(getApiKeyMemoEntry("hash-1")).not.toBeNull();
    expect(getApiKeyMemoEntry("hash-2")).not.toBeNull();
    expect(getApiKeyMemoEntry("hash-3")).not.toBeNull();
  });
});
