/**
 * In-process positive cache for validated API keys.
 *
 * Why this exists:
 * - The previous request flow was `getCached(redis) -> ApiKey.findOne(mongo) ×2 -> setCache(redis)`.
 * - When Redis is unreachable (production state observed 2026-05-13), `getCached` now fast-skips
 *   (see `src/lib/redis.ts`), so every licensed request pays a full Atlas round-trip for API-key
 *   validation. Mongo round-trips from App Runner add 1.5-3s per request and rate-limit the
 *   Engine even though the actual valuation work takes <30ms.
 * - A small in-process map of hashed-key -> apiKeyEntry with a 60s TTL absorbs that cost
 *   entirely. Redis is still consulted (and populated when healthy) so multi-instance fleets
 *   stay coherent within seconds.
 *
 * Security/notes:
 * - Keyed by HMAC-SHA256 hashed key (matches Mongo `keyHash`). The raw key never enters this
 *   map.
 * - Positive entries only. Unknown keys are NOT cached; rate-limiter handles abuse.
 * - LRU bounded at 1k entries. Eviction is FIFO on overflow.
 * - Auto-disabled under Vitest unless `VITEST=false` is set, so tests cannot leak state.
 *
 * Env:
 * - `AMETHYST_API_KEY_MEMO_TTL_MS=<int>` — TTL override (default 60000, clamp 1000..600000).
 * - `AMETHYST_DISABLE_API_KEY_MEMO_CACHE=1` — bypass entirely.
 *
 * Tests: `test/apiKeyMemoryCache.test.ts`.
 */

import type { ApiKeyScope } from "./apiKey";

export type ApiKeyMemoEntry = {
  owner: string;
  tier: string;
  isActive: boolean;
  scopes: ApiKeyScope[];
};

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 600_000;
const MAX_ENTRIES = 1_000;

type CacheEntry = ApiKeyMemoEntry & { expiresAtMs: number };

const store = new Map<string, CacheEntry>();

function readTtlMs(): number {
  const raw = process.env.AMETHYST_API_KEY_MEMO_TTL_MS;
  if (raw == null || raw === "") return DEFAULT_TTL_MS;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_TTL_MS;
  if (n < MIN_TTL_MS) return MIN_TTL_MS;
  if (n > MAX_TTL_MS) return MAX_TTL_MS;
  return n;
}

export function apiKeyMemoTtlMs(): number {
  return readTtlMs();
}

export function isApiKeyMemoCacheDisabled(): boolean {
  if (process.env.AMETHYST_DISABLE_API_KEY_MEMO_CACHE === "1") return true;
  if (process.env.VITEST === "true") return true;
  return false;
}

/** Returns a fresh shallow copy of the cached entry, or `null` on miss / expiry / disabled. */
export function getApiKeyMemoEntry(
  hashedKey: string,
  now: number = Date.now()
): ApiKeyMemoEntry | null {
  if (isApiKeyMemoCacheDisabled()) return null;
  const e = store.get(hashedKey);
  if (!e) return null;
  if (e.expiresAtMs <= now) {
    store.delete(hashedKey);
    return null;
  }
  // LRU touch so hot keys survive eviction.
  store.delete(hashedKey);
  store.set(hashedKey, e);
  return {
    owner: e.owner,
    tier: e.tier,
    isActive: e.isActive,
    scopes: [...e.scopes],
  };
}

export function setApiKeyMemoEntry(
  hashedKey: string,
  entry: ApiKeyMemoEntry,
  now: number = Date.now()
): void {
  if (isApiKeyMemoCacheDisabled()) return;
  const ttlMs = readTtlMs();
  store.set(hashedKey, {
    owner: entry.owner,
    tier: entry.tier,
    isActive: entry.isActive,
    scopes: [...entry.scopes],
    expiresAtMs: now + ttlMs,
  });
  if (store.size > MAX_ENTRIES) {
    const firstKey = store.keys().next().value;
    if (firstKey != null) store.delete(firstKey);
  }
}

export function invalidateApiKeyMemoEntry(hashedKey: string): void {
  store.delete(hashedKey);
}

export function clearApiKeyMemoCache(): void {
  store.clear();
}

/** Test helper. */
export function __apiKeyMemoCacheSize(): number {
  return store.size;
}
