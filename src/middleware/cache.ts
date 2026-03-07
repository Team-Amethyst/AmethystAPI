import { Request, Response, NextFunction } from "express";
import { getCached, setCache } from "../lib/redis";

/**
 * Returns an Express middleware that caches successful (200) JSON responses
 * in Redis for the given TTL.
 *
 * @param ttlSeconds  Cache time-to-live in seconds (default: 300)
 * @param keyFn       Optional custom key derivation function
 */
export function cacheMiddleware(
  ttlSeconds = 300,
  keyFn?: (req: Request) => string
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const cacheKey = keyFn
      ? keyFn(req)
      : `ae:${req.method}:${req.path}:${JSON.stringify(req.query)}`;

    const cached = await getCached<unknown>(cacheKey);
    if (cached !== null) {
      res.setHeader("X-Brain-Cache", "HIT");
      res.json(cached);
      return;
    }

    // Intercept res.json to store the response before sending
    const originalJson = res.json.bind(res) as typeof res.json;
    res.json = (body: unknown) => {
      if (res.statusCode === 200) {
        setCache(cacheKey, body, ttlSeconds).catch(() => {});
      }
      res.setHeader("X-Brain-Cache", "MISS");
      return originalJson(body);
    };

    next();
  };
}
