import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import {
  __setRedisClientForTests,
  deleteCache,
  getCached,
  isRedisReady,
  redisCacheTimeoutMs,
  setCache,
} from "../src/lib/redis";

type FakeRedis = {
  status: string;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

function makeFakeRedis(status: string, overrides: Partial<FakeRedis> = {}): FakeRedis {
  return {
    status,
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve("OK")),
    del: vi.fn(() => Promise.resolve(1)),
    ...overrides,
  };
}

function never<T>(): Promise<T> {
  return new Promise(() => undefined);
}

const ORIGINAL_TIMEOUT = process.env.REDIS_CACHE_TIMEOUT_MS;

beforeEach(() => {
  __setRedisClientForTests(null);
});

afterEach(() => {
  __setRedisClientForTests(null);
  if (ORIGINAL_TIMEOUT === undefined) delete process.env.REDIS_CACHE_TIMEOUT_MS;
  else process.env.REDIS_CACHE_TIMEOUT_MS = ORIGINAL_TIMEOUT;
});

describe("Redis cache helpers — non-blocking", () => {
  it("isRedisReady() is false when there is no client", () => {
    expect(isRedisReady()).toBe(false);
  });

  it("isRedisReady() is false when client status is not 'ready'", () => {
    const fake = makeFakeRedis("reconnecting");
    __setRedisClientForTests(fake as unknown as Redis);
    expect(isRedisReady()).toBe(false);
  });

  it("isRedisReady() is true when client status is 'ready'", () => {
    const fake = makeFakeRedis("ready");
    __setRedisClientForTests(fake as unknown as Redis);
    expect(isRedisReady()).toBe(true);
  });

  it("redisCacheTimeoutMs() defaults to 50 and clamps env overrides", () => {
    delete process.env.REDIS_CACHE_TIMEOUT_MS;
    expect(redisCacheTimeoutMs()).toBe(50);

    process.env.REDIS_CACHE_TIMEOUT_MS = "120";
    expect(redisCacheTimeoutMs()).toBe(120);

    process.env.REDIS_CACHE_TIMEOUT_MS = "0";
    expect(redisCacheTimeoutMs()).toBe(5);

    process.env.REDIS_CACHE_TIMEOUT_MS = "100000";
    expect(redisCacheTimeoutMs()).toBe(500);

    process.env.REDIS_CACHE_TIMEOUT_MS = "abc";
    expect(redisCacheTimeoutMs()).toBe(50);
  });

  it("getCached returns null quickly when Redis is not ready (no get() call)", async () => {
    const fake = makeFakeRedis("reconnecting", { get: vi.fn(() => never<string>()) });
    __setRedisClientForTests(fake as unknown as Redis);

    const t0 = performance.now();
    const v = await getCached<string>("k");
    const dt = performance.now() - t0;

    expect(v).toBeNull();
    expect(fake.get).not.toHaveBeenCalled();
    expect(dt).toBeLessThan(20);
  });

  it("setCache resolves quickly when Redis is not ready (no set() call)", async () => {
    const fake = makeFakeRedis("end", { set: vi.fn(() => never<"OK">()) });
    __setRedisClientForTests(fake as unknown as Redis);

    const t0 = performance.now();
    await setCache("k", { a: 1 });
    const dt = performance.now() - t0;

    expect(fake.set).not.toHaveBeenCalled();
    expect(dt).toBeLessThan(20);
  });

  it("deleteCache resolves quickly when Redis is not ready", async () => {
    const fake = makeFakeRedis("wait", { del: vi.fn(() => never<number>()) });
    __setRedisClientForTests(fake as unknown as Redis);

    const t0 = performance.now();
    await deleteCache("k");
    const dt = performance.now() - t0;

    expect(fake.del).not.toHaveBeenCalled();
    expect(dt).toBeLessThan(20);
  });

  it("getCached returns null after the configured timeout when the get hangs", async () => {
    process.env.REDIS_CACHE_TIMEOUT_MS = "30";
    const fake = makeFakeRedis("ready", { get: vi.fn(() => never<string>()) });
    __setRedisClientForTests(fake as unknown as Redis);

    const t0 = performance.now();
    const v = await getCached<string>("k");
    const dt = performance.now() - t0;

    expect(v).toBeNull();
    expect(fake.get).toHaveBeenCalled();
    expect(dt).toBeGreaterThanOrEqual(20);
    expect(dt).toBeLessThan(200);
  });

  it("setCache resolves (no throw) after timeout when the set hangs", async () => {
    process.env.REDIS_CACHE_TIMEOUT_MS = "30";
    const fake = makeFakeRedis("ready", { set: vi.fn(() => never<"OK">()) });
    __setRedisClientForTests(fake as unknown as Redis);

    const t0 = performance.now();
    await expect(setCache("k", { a: 1 })).resolves.toBeUndefined();
    const dt = performance.now() - t0;

    expect(fake.set).toHaveBeenCalled();
    expect(dt).toBeLessThan(200);
  });

  it("getCached returns null and does not throw when Redis throws an error", async () => {
    const fake = makeFakeRedis("ready", {
      get: vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    });
    __setRedisClientForTests(fake as unknown as Redis);

    await expect(getCached<string>("k")).resolves.toBeNull();
  });

  it("setCache swallows errors from the underlying client", async () => {
    const fake = makeFakeRedis("ready", {
      set: vi.fn(() => Promise.reject(new Error("WRONGTYPE"))),
    });
    __setRedisClientForTests(fake as unknown as Redis);

    await expect(setCache("k", { a: 1 })).resolves.toBeUndefined();
  });

  it("healthy Redis path: getCached parses JSON and returns the value", async () => {
    const stored = JSON.stringify({ hello: "world" });
    const fake = makeFakeRedis("ready", { get: vi.fn(() => Promise.resolve(stored)) });
    __setRedisClientForTests(fake as unknown as Redis);

    const v = await getCached<{ hello: string }>("k");
    expect(v).toEqual({ hello: "world" });
    expect(fake.get).toHaveBeenCalledWith("k");
  });

  it("healthy Redis path: setCache writes the serialized value with EX", async () => {
    const fake = makeFakeRedis("ready");
    __setRedisClientForTests(fake as unknown as Redis);

    await setCache("k", { hello: "world" }, 120);
    expect(fake.set).toHaveBeenCalledWith(
      "k",
      JSON.stringify({ hello: "world" }),
      "EX",
      120
    );
  });

  it("healthy Redis path: deleteCache calls del", async () => {
    const fake = makeFakeRedis("ready");
    __setRedisClientForTests(fake as unknown as Redis);

    await deleteCache("k");
    expect(fake.del).toHaveBeenCalledWith("k");
  });

  it("getCached returns null when the stored value is empty/null (cache miss)", async () => {
    const fake = makeFakeRedis("ready", { get: vi.fn(() => Promise.resolve(null)) });
    __setRedisClientForTests(fake as unknown as Redis);

    const v = await getCached<string>("k");
    expect(v).toBeNull();
  });
});
