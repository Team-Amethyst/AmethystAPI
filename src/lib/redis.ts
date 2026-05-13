/**
 * Redis client + non-blocking cache helpers.
 *
 * Redis is **optional** for the Engine — when the server is unreachable or in
 * a reconnect loop, cache calls must NOT block licensed-request paths (API
 * key validation, news signals, /catalog/batch-values). Two defenses:
 *
 * 1. **Readiness pre-check.** Before any Redis op we check
 *    `client.status === "ready"`. If not, we return cache-miss / no-op
 *    immediately (no socket I/O, no retries).
 * 2. **Hard timeout race.** Even on a "ready" client, `get`/`set`/`del`
 *    races against a 50 ms (default) timer. Stalls hand back fast.
 *
 * Tunable via `REDIS_CACHE_TIMEOUT_MS` (clamp 5..500 ms). Logging is
 * throttled (one warn per minute per op/reason pair) so a sustained outage
 * does not flood pino.
 *
 * Behavior:
 * - `getCached` resolves to `null` on miss / not-ready / timeout / error.
 * - `setCache` and `deleteCache` resolve to `void` regardless of outcome.
 * - Neither helper ever rejects.
 *
 * Tests: `test/redisCacheNonBlocking.test.ts`.
 */

import { Redis } from "ioredis";
import { env } from "../config/env";
import { logger } from "./logger";

const DEFAULT_CACHE_TIMEOUT_MS = 50;
const MIN_CACHE_TIMEOUT_MS = 5;
const MAX_CACHE_TIMEOUT_MS = 500;
const WARN_THROTTLE_MS = 60_000;

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = env.redisUrl;
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    redisClient.on("error", (err: Error) => {
      warnThrottled("client_error", err.message);
    });
    redisClient.on("connect", () => {
      logger.info("Redis connected");
    });
  }
  return redisClient;
}

/** Test-only: inject a fake client. Restore by passing `null`. */
export function __setRedisClientForTests(client: Redis | null): void {
  redisClient = client;
}

function readTimeoutMs(): number {
  const raw = process.env.REDIS_CACHE_TIMEOUT_MS;
  if (raw == null || raw === "") return DEFAULT_CACHE_TIMEOUT_MS;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_CACHE_TIMEOUT_MS;
  if (n < MIN_CACHE_TIMEOUT_MS) return MIN_CACHE_TIMEOUT_MS;
  if (n > MAX_CACHE_TIMEOUT_MS) return MAX_CACHE_TIMEOUT_MS;
  return n;
}

export function redisCacheTimeoutMs(): number {
  return readTimeoutMs();
}

/** True only when the singleton client exists AND ioredis reports "ready". */
export function isRedisReady(): boolean {
  return redisClient != null && redisClient.status === "ready";
}

const warnLastMs = new Map<string, number>();
function warnThrottled(op: string, reason: string): void {
  const key = `${op}:${reason}`;
  const now = Date.now();
  const last = warnLastMs.get(key) ?? 0;
  if (now - last < WARN_THROTTLE_MS) return;
  warnLastMs.set(key, now);
  logger.warn({ op, reason, component: "RedisCache" }, "redis cache degraded");
}

class RedisCacheTimeout extends Error {
  constructor(public readonly op: string) {
    super(`redis ${op} timeout`);
    this.name = "RedisCacheTimeout";
  }
}

function withTimeout<T>(op: string, p: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new RedisCacheTimeout(op)), timeoutMs);
  });
  return Promise.race([p, timer]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

export async function getCached<T>(key: string): Promise<T | null> {
  if (!isRedisReady()) {
    warnThrottled("get", "not_ready");
    return null;
  }
  const timeoutMs = readTimeoutMs();
  try {
    const data = await withTimeout(
      "get",
      getRedisClient().get(key),
      timeoutMs
    );
    return data ? (JSON.parse(data) as T) : null;
  } catch (err) {
    if (err instanceof RedisCacheTimeout) {
      warnThrottled("get", "timeout");
    } else {
      warnThrottled("get", "error");
    }
    return null;
  }
}

export async function setCache(
  key: string,
  value: unknown,
  ttlSeconds = 300
): Promise<void> {
  if (!isRedisReady()) {
    warnThrottled("set", "not_ready");
    return;
  }
  const timeoutMs = readTimeoutMs();
  try {
    await withTimeout(
      "set",
      getRedisClient().set(key, JSON.stringify(value), "EX", ttlSeconds),
      timeoutMs
    );
  } catch (err) {
    if (err instanceof RedisCacheTimeout) {
      warnThrottled("set", "timeout");
    } else {
      warnThrottled("set", "error");
    }
  }
}

export async function deleteCache(key: string): Promise<void> {
  if (!isRedisReady()) {
    warnThrottled("del", "not_ready");
    return;
  }
  const timeoutMs = readTimeoutMs();
  try {
    await withTimeout("del", getRedisClient().del(key), timeoutMs);
  } catch (err) {
    if (err instanceof RedisCacheTimeout) {
      warnThrottled("del", "timeout");
    } else {
      warnThrottled("del", "error");
    }
  }
}
