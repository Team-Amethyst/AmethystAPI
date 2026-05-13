import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeanPlayer } from "../src/types/brain";

/*
 * Catalog cache test: keep the Player.find mock at module scope so it can be
 * inspected per scenario. The cache short-circuit must run before any DB call.
 */
const findSpy = vi.fn();
function makeFakeQuery(pool: LeanPlayer[]) {
  const q = {
    select: vi.fn(() => q),
    lean: vi.fn(() => Promise.resolve(pool)),
  };
  return q;
}

vi.mock("../src/models/Player", () => ({
  default: {
    find: (...args: unknown[]) => findSpy(...args),
  },
}));

const POOL: LeanPlayer[] = Array.from({ length: 8 }, (_, i) => ({
  _id: `db_${i}`,
  mlbId: i + 1,
  name: `Player_${i + 1}`,
  team: "NYY",
  position: "OF",
  catalog_rank: i + 1,
  catalog_tier: 1,
  value: 30 - i,
}));

async function importPipeline(): Promise<typeof import("../src/lib/mongoCatalogPipeline")> {
  return await import("../src/lib/mongoCatalogPipeline");
}
async function importCache(): Promise<typeof import("../src/lib/mongoCatalogCache")> {
  return await import("../src/lib/mongoCatalogCache");
}

const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_DISABLED = process.env.AMETHYST_CATALOG_CACHE_DISABLED;
const ORIGINAL_DISABLE_CATALOG = process.env.AMETHYST_DISABLE_CATALOG_CACHE;
const ORIGINAL_TTL = process.env.AMETHYST_CATALOG_CACHE_TTL_MS;

beforeEach(() => {
  findSpy.mockReset();
  findSpy.mockImplementation(() => makeFakeQuery(POOL));
});

afterEach(async () => {
  const { __resetMongoCatalogCacheForTests } = await importCache();
  __resetMongoCatalogCacheForTests();
  if (ORIGINAL_VITEST === undefined) delete process.env.VITEST;
  else process.env.VITEST = ORIGINAL_VITEST;
  if (ORIGINAL_DISABLED === undefined) delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
  else process.env.AMETHYST_CATALOG_CACHE_DISABLED = ORIGINAL_DISABLED;
  if (ORIGINAL_DISABLE_CATALOG === undefined) delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;
  else process.env.AMETHYST_DISABLE_CATALOG_CACHE = ORIGINAL_DISABLE_CATALOG;
  if (ORIGINAL_TTL === undefined) delete process.env.AMETHYST_CATALOG_CACHE_TTL_MS;
  else process.env.AMETHYST_CATALOG_CACHE_TTL_MS = ORIGINAL_TTL;
});

describe("loadMongoCatalogForEngine catalog cache", () => {
  it("is disabled under vitest by default (each call hits Mongo)", async () => {
    process.env.VITEST = "true";
    const { loadMongoCatalogForEngine } = await importPipeline();
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    expect(findSpy).toHaveBeenCalledTimes(2);
  });

  it("caches valuation-eligible rows on the skipHydration hot path", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;
    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "60000";

    const { loadMongoCatalogForEngine } = await importPipeline();
    const first = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    const second = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(second.length).toBe(first.length);
    expect(second.length).toBe(POOL.length);
  });

  it("AMETHYST_CATALOG_CACHE_DISABLED=1 bypasses the cache", async () => {
    process.env.VITEST = "false";
    process.env.AMETHYST_CATALOG_CACHE_DISABLED = "1";
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;

    const { loadMongoCatalogForEngine } = await importPipeline();
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    expect(findSpy).toHaveBeenCalledTimes(2);
  });

  it("AMETHYST_DISABLE_CATALOG_CACHE=1 bypasses the cache", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    process.env.AMETHYST_DISABLE_CATALOG_CACHE = "1";

    const { loadMongoCatalogForEngine } = await importPipeline();
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    expect(findSpy).toHaveBeenCalledTimes(2);
  });

  it("expires the cache after the configured TTL", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;
    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "1";

    const { loadMongoCatalogForEngine } = await importPipeline();
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    await new Promise((r) => setTimeout(r, 5));
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    expect(findSpy).toHaveBeenCalledTimes(2);
  });

  it("does not cache when hydration is requested (debug path stays fresh)", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;

    const { loadMongoCatalogForEngine } = await importPipeline();
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: false });
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: false });
    expect(findSpy).toHaveBeenCalledTimes(2);
  });

  it("records mongo_catalog_cache_hit in diagnostics when serving from cache", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;
    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "60000";

    const { loadMongoCatalogForEngine } = await importPipeline();
    const { createValuationRequestDiagnostics } = await import(
      "../src/lib/valuationRequestTiming"
    );

    const warm = createValuationRequestDiagnostics();
    await loadMongoCatalogForEngine(undefined, {
      skipMlbHydration: true,
      diagnostics: warm,
    });
    expect(warm.counts.mongo_catalog_cache_hit).toBe(0);

    const hot = createValuationRequestDiagnostics();
    await loadMongoCatalogForEngine(undefined, {
      skipMlbHydration: true,
      diagnostics: hot,
    });
    expect(hot.counts.mongo_catalog_cache_hit).toBe(1);
    expect(hot.timings_ms.mongo_catalog_find_ms).toBe(0);
    expect(hot.timings_ms.mongo_catalog_hydrate_ms).toBe(0);
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it("returns isolated row objects so request mutation does not corrupt the cache", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;
    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "60000";

    const { loadMongoCatalogForEngine } = await importPipeline();
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    const mutated = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    mutated[0]!.name = "CORRUPTED_BY_REQUEST";

    const fresh = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    expect(fresh[0]!.name).toBe("Player_1");
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it("default TTL is 5 minutes (300000 ms)", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;
    delete process.env.AMETHYST_CATALOG_CACHE_TTL_MS;

    const { getCatalogCacheTtlMs, CATALOG_CACHE_DEFAULT_TTL_MS } = await importCache();
    expect(CATALOG_CACHE_DEFAULT_TTL_MS).toBe(300_000);
    expect(getCatalogCacheTtlMs()).toBe(300_000);
  });

  it("AMETHYST_CATALOG_CACHE_TTL_MS env override is honored (and clamped)", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;

    const { getCatalogCacheTtlMs } = await importCache();

    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "30000";
    expect(getCatalogCacheTtlMs()).toBe(30_000);

    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "0";
    expect(getCatalogCacheTtlMs()).toBe(1);

    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "9999999";
    expect(getCatalogCacheTtlMs()).toBe(600_000);

    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "not-a-number";
    expect(getCatalogCacheTtlMs()).toBe(300_000);
  });

  it("invalidateCatalogCache() drops the entry (sync-players parity)", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;
    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "60000";

    const { loadMongoCatalogForEngine, invalidateCatalogCache } = await importPipeline();
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    expect(findSpy).toHaveBeenCalledTimes(1);

    invalidateCatalogCache();

    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    expect(findSpy).toHaveBeenCalledTimes(2);
  });

  it("warmCatalogCache() populates the cache and logs success", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;
    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "60000";

    const { warmCatalogCache, loadMongoCatalogForEngine } = await importPipeline();
    const infoSpy = vi.fn();
    const log = { warn: vi.fn(), info: infoSpy, error: vi.fn() };

    const result = await warmCatalogCache(log);
    expect(result.warmed).toBe(true);
    expect(result).toMatchObject({ warmed: true, rows: POOL.length });
    expect(infoSpy).toHaveBeenCalled();
    const warmLog = infoSpy.mock.calls.find((call) =>
      String(call[1] ?? "").includes("catalog cache warmed")
    );
    expect(warmLog).toBeTruthy();
    expect((warmLog?.[0] ?? {}) as Record<string, unknown>).toMatchObject({
      catalog_cache_warm_on_startup: true,
      catalog_cache_ttl_ms: 60_000,
      catalog_pool_size: POOL.length,
    });

    await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it("warmCatalogCache() logs but does not throw when the load fails", async () => {
    process.env.VITEST = "false";
    delete process.env.AMETHYST_CATALOG_CACHE_DISABLED;
    delete process.env.AMETHYST_DISABLE_CATALOG_CACHE;
    process.env.AMETHYST_CATALOG_CACHE_TTL_MS = "60000";

    findSpy.mockImplementationOnce(() => ({
      select: () => ({
        lean: () => Promise.reject(new Error("simulated atlas outage")),
      }),
    }));

    const { warmCatalogCache } = await importPipeline();
    const errorSpy = vi.fn();
    const log = { warn: vi.fn(), info: vi.fn(), error: errorSpy };

    const result = await warmCatalogCache(log);
    expect(result.warmed).toBe(false);
    if (!result.warmed && result.skipped === false) {
      expect(result.reason).toBe("error");
      expect(result.error).toContain("simulated atlas outage");
    }
    expect(errorSpy).toHaveBeenCalled();
    const failLog = errorSpy.mock.calls.find((call) =>
      String(call[1] ?? "").includes("catalog cache warm failed")
    );
    expect(failLog).toBeTruthy();
    expect((failLog?.[0] ?? {}) as Record<string, unknown>).toMatchObject({
      catalog_cache_warm_on_startup: false,
      error: expect.stringContaining("simulated atlas outage"),
    });
  });

  it("warmCatalogCache() is a no-op when the cache is disabled", async () => {
    process.env.VITEST = "false";
    process.env.AMETHYST_DISABLE_CATALOG_CACHE = "1";

    const { warmCatalogCache } = await importPipeline();
    const infoSpy = vi.fn();
    const log = { warn: vi.fn(), info: infoSpy, error: vi.fn() };

    const result = await warmCatalogCache(log);
    expect(result).toMatchObject({ warmed: false, reason: "disabled", skipped: true });
    expect(findSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
  });
});
