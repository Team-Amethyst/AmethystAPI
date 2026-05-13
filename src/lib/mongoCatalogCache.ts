/**
 * In-process cache for the valuation-eligible Mongo catalog snapshot loaded by
 * `loadMongoCatalogForEngine`.
 *
 * Goal: absorb the hot-path cost of `Player.find({})` + normalization +
 * eligibility filtering once roster-universe expanded the catalog. A cold
 * load from Atlas can take multiple seconds; the cache turns subsequent
 * `/valuation/*` calls into ≤1ms catalog reads. Because the catalog only
 * changes when `pnpm sync-players` runs (rare, operator-initiated), a
 * **5-minute default TTL** is safe and dramatically reduces cold-miss
 * exposure (App Runner instance startup, pod recycle, etc.).
 *
 * Properties:
 * - Only the **post-normalize, post-eligibility-filter** rows are cached —
 *   the array `loadMongoCatalogForEngine` would return with
 *   `skipMlbHydration: true`.
 * - Callers that opt into MLB hydration bypass the cache (debug / scripts).
 * - Stored and returned rows are **`structuredClone`d** so request-side
 *   mutation cannot corrupt the cache or other requests.
 * - Env:
 *   - `AMETHYST_DISABLE_CATALOG_CACHE=1` (preferred) or
 *     `AMETHYST_CATALOG_CACHE_DISABLED=1` (legacy alias) — bypass entirely.
 *   - `AMETHYST_CATALOG_CACHE_TTL_MS=<int>` — TTL override
 *     (default **300000** ms = 5 minutes; clamp 1..600000).
 * - Auto-disabled when `VITEST=true` unless tests override `VITEST=false`.
 *
 * Invalidation: callers that mutate the `players` collection in-process
 * (e.g. `scripts/sync-players.ts` when run inside an API process) should
 * call `invalidateCatalogCache()` after writes so the next
 * `loadMongoCatalogForEngine` sees fresh rows. Separate processes refresh
 * naturally on the next TTL window.
 *
 * Tests: `test/mongoCatalogCache.test.ts`.
 */

import type { LeanPlayer } from "../types/brain";

const DEFAULT_TTL_MS = 300_000;
const MIN_TTL_MS = 1;
const MAX_TTL_MS = 600_000;

export const CATALOG_CACHE_DEFAULT_TTL_MS = DEFAULT_TTL_MS;

type CacheEntry = {
  rows: LeanPlayer[];
  cachedAtMs: number;
  expiresAtMs: number;
};

let entry: CacheEntry | null = null;

function readEnvTtlMs(): number {
  const raw = process.env.AMETHYST_CATALOG_CACHE_TTL_MS;
  if (raw == null || raw === "") return DEFAULT_TTL_MS;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_TTL_MS;
  if (n < MIN_TTL_MS) return MIN_TTL_MS;
  if (n > MAX_TTL_MS) return MAX_TTL_MS;
  return n;
}

export function isCatalogCacheDisabled(): boolean {
  if (process.env.AMETHYST_DISABLE_CATALOG_CACHE === "1") return true;
  if (process.env.AMETHYST_CATALOG_CACHE_DISABLED === "1") return true;
  if (process.env.VITEST === "true") return true;
  return false;
}

export function getCatalogCacheTtlMs(): number {
  return readEnvTtlMs();
}

/** Age of the current fresh entry, for logging; `null` if no entry or stale. */
export function getCatalogCacheAgeMs(now: number = Date.now()): number | null {
  const e = entry;
  if (!e || e.expiresAtMs <= now) return null;
  return now - e.cachedAtMs;
}

/** Returns a **deep clone** of cached rows if still fresh, else `null`. */
export function getCachedValuationEligibleRows(now: number = Date.now()): LeanPlayer[] | null {
  if (isCatalogCacheDisabled()) return null;
  const e = entry;
  if (!e || e.expiresAtMs <= now) {
    entry = null;
    return null;
  }
  return structuredClone(e.rows);
}

/** Stores a **deep clone** of rows with TTL. No-op when cache is disabled. */
export function setCachedValuationEligibleRows(
  rows: ReadonlyArray<LeanPlayer>,
  now: number = Date.now()
): void {
  if (isCatalogCacheDisabled()) return;
  const ttl = readEnvTtlMs();
  entry = {
    rows: structuredClone(rows) as LeanPlayer[],
    cachedAtMs: now,
    expiresAtMs: now + ttl,
  };
}

/**
 * Drop the cached snapshot. Call after in-process writes to `players` (e.g.
 * sync-players sharing a process with the API) so the next load sees fresh
 * data. Cross-process callers do not need this — the TTL handles it.
 */
export function invalidateCatalogCache(): void {
  entry = null;
}

/** Test helper alias for clarity in test files. */
export function __resetMongoCatalogCacheForTests(): void {
  invalidateCatalogCache();
}
