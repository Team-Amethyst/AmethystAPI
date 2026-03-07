import { Redis } from "ioredis";

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    redisClient.on("error", (err: Error) => {
      console.error("[Redis] Connection error:", err.message);
    });
    redisClient.on("connect", () => {
      console.log("[Redis] Connected");
    });
  }
  return redisClient;
}

export async function getCached<T>(key: string): Promise<T | null> {
  try {
    const data = await getRedisClient().get(key);
    return data ? (JSON.parse(data) as T) : null;
  } catch {
    // Redis failure is non-fatal — fall through to source
    return null;
  }
}

export async function setCache(
  key: string,
  value: unknown,
  ttlSeconds = 300
): Promise<void> {
  try {
    await getRedisClient().set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // Non-fatal
  }
}

export async function deleteCache(key: string): Promise<void> {
  try {
    await getRedisClient().del(key);
  } catch {
    // Non-fatal
  }
}
