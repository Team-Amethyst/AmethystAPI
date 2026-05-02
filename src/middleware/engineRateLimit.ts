import rateLimit from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import { env } from "../config/env";
import type { ApiKeyRequest } from "./apiKey";
import { catalogLimitForTier, valuationLimitForTier } from "./tierRateLimits";

function apiKeyOrIpKey(req: Request): string {
  const raw = req.headers["x-api-key"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return `k:${raw.trim().slice(0, 128)}`;
  }
  return `ip:${req.ip ?? "unknown"}`;
}

/**
 * Master switch: `RATE_LIMIT_ENABLED=0|false|off` disables all engine limiters.
 * Automatically off under Vitest unless `RATE_LIMIT_ENABLED=1` is set (for 429 tests).
 */
export function isEngineRateLimitingEnabled(): boolean {
  const v = process.env.RATE_LIMIT_ENABLED?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") {
    return false;
  }
  if (v === "1" || v === "true" || v === "on" || v === "yes") {
    return true;
  }
  if (env.isVitest) {
    return false;
  }
  return true;
}

const noop: RequestHandler = (_req, _res, next) => {
  next();
};

function createLimiter(options: {
  windowMs: number;
  limit: number | ((req: Request) => number | Promise<number>);
  message: string;
}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => apiKeyOrIpKey(req),
    message: {
      message: options.message,
      error: { code: "RATE_LIMIT_EXCEEDED" },
    },
  });
}

/**
 * Full-catalog valuation: defaults 300 requests / minute / API key (or IP).
 *
 * Env: `RATE_LIMIT_VALUATION_WINDOW_MS`, `RATE_LIMIT_VALUATION_MAX`
 */
export function valuationRateLimiter(): RequestHandler {
  if (!isEngineRateLimitingEnabled()) {
    return noop;
  }
  return createLimiter({
    windowMs: env.rateLimit.valuationWindowMs,
    limit: (req) =>
      valuationLimitForTier((req as ApiKeyRequest).apiKeyTier),
    message:
      "Too many valuation requests. Please slow down and try again shortly.",
  });
}

/**
 * Catalog batch-values: higher default ceiling than valuation (smaller per-request work).
 *
 * Env: `RATE_LIMIT_CATALOG_WINDOW_MS`, `RATE_LIMIT_CATALOG_MAX`
 */
export function catalogRateLimiter(): RequestHandler {
  if (!isEngineRateLimitingEnabled()) {
    return noop;
  }
  const windowMs = env.rateLimit.catalogWindowMs;
  return createLimiter({
    windowMs,
    limit: (req) => catalogLimitForTier((req as ApiKeyRequest).apiKeyTier),
    message:
      "Too many catalog requests. Please slow down and try again shortly.",
  });
}
