import mongoose from "mongoose";
import { getRedisClient } from "./redis";

const REDIS_PING_MS = 750;

export type ReadinessBody = {
  status: "ready" | "not_ready" | "degraded";
  mongodb: "up" | "down";
  redis: "up" | "down" | "skipped";
  timestamp: string;
  service: string;
  version: string;
};

/**
 * MongoDB must be connected (readyState 1). Redis is optional for core valuation;
 * when `HEALTHCHECK_REDIS=0`, skip ping; otherwise a failed ping yields `degraded` but still 200.
 */
export async function getReadiness(): Promise<ReadinessBody> {
  const mongoUp = mongoose.connection.readyState === 1;

  let redis: "up" | "down" | "skipped" = "skipped";
  if (process.env.HEALTHCHECK_REDIS !== "0") {
    try {
      await Promise.race([
        getRedisClient().ping(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("redis ping timeout")),
            REDIS_PING_MS
          )
        ),
      ]);
      redis = "up";
    } catch {
      redis = "down";
    }
  }

  let status: ReadinessBody["status"];
  if (!mongoUp) {
    status = "not_ready";
  } else if (redis === "down") {
    status = "degraded";
  } else {
    status = "ready";
  }

  return {
    status,
    mongodb: mongoUp ? "up" : "down",
    redis,
    timestamp: new Date().toISOString(),
    service: "Amethyst Engine",
    version: "1.0.0",
  };
}

export function readinessHttpStatus(body: ReadinessBody): number {
  return body.mongodb === "up" ? 200 : 503;
}
