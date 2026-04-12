import rateLimit from "express-rate-limit";
import type { Request } from "express";

function valuationClientKey(req: Request): string {
  const raw = req.headers["x-api-key"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return `k:${raw.trim().slice(0, 128)}`;
  }
  return `ip:${req.ip ?? "unknown"}`;
}

/**
 * Per-API-key (or IP) throttle for the expensive full-catalog valuation endpoint.
 */
export const valuationRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => valuationClientKey(req),
  message: {
    message: "Too many valuation requests. Please slow down and try again.",
    error: { code: "RATE_LIMIT_EXCEEDED" },
  },
});
