import { Request, Response, NextFunction } from "express";
import ApiKey from "../models/ApiKey";
import { getCached, setCache } from "../lib/redis";
import { UnauthorizedError, ForbiddenError } from "../lib/appError";

const CACHE_PREFIX = "ae:apikey:";
const CACHE_TTL_SECONDS = 60;

/** Attaches licensing metadata to the request after successful key validation. */
export interface ApiKeyRequest extends Request {
  apiKeyOwner?: string;
  apiKeyTier?: string;
}

/**
 * Validates the x-api-key header for every request to the Amethyst Engine.
 *
 * Usage is tracked asynchronously so it never blocks the hot path.
 * The usageCount field feeds the 5% net-revenue royalty calculation
 * reported back to the primary stakeholder.
 */
const apiKeyMiddleware = async (
  req: ApiKeyRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const rawKey = req.headers["x-api-key"];

  if (!rawKey || typeof rawKey !== "string" || rawKey.trim() === "") {
    // res.status(401).json({
    //   error: "Unauthorized",
    //   message: "A valid x-api-key header is required to access the Amethyst Engine API.",
    // });
    // return;
    throw new UnauthorizedError("A valid x-api-key header is required to access the Amethyst Engine API.", 401, "API_KEY_MISSING");
  }

  const key = rawKey.trim();

  // Reject keys that don't match the expected format — prevents injection
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
    // res.status(401).json({
    //   error: "Unauthorized",
    //   message: "Invalid API key format.",
    // });
    // return;
    throw new UnauthorizedError("Invalid API key format.", 401, "API_KEY_INVALID_FORMAT");
  }

  try {
    const cacheKey = `${CACHE_PREFIX}${key}`;
    let cached = await getCached<{
      owner: string;
      tier: string;
      isActive: boolean;
    }>(cacheKey);

    if (!cached) {
      const doc = await ApiKey.findOne({ key }).lean();
      if (!doc) {
        // res
        //   .status(401)
        //   .json({ error: "Unauthorized", message: "API key not recognized." });
        // return;
        throw new UnauthorizedError("API key not recognized.", 401, "API_KEY_NOT_FOUND");
      }
      if (!doc.isActive) {
        // res
        //   .status(403)
        //   .json({ error: "Forbidden", message: "API key has been deactivated." });
        // return;
        throw new ForbiddenError("API key has been deactivated.", 403, "API_KEY_DEACTIVATED");
      }
      cached = { owner: doc.owner, tier: doc.tier, isActive: doc.isActive };
      await setCache(cacheKey, cached, CACHE_TTL_SECONDS);

      // Async usage increment — never awaited so it never blocks the response
      ApiKey.findOneAndUpdate(
        { key },
        { $inc: { usageCount: 1 }, $set: { lastUsed: new Date() } }
      ).catch((err: Error) =>
        console.error("[ApiKey] Usage tracking error:", err.message)
      );
    }

    req.apiKeyOwner = cached.owner;
    req.apiKeyTier = cached.tier;
    next();
  } catch (err) {
    // console.error("[ApiKey] Middleware error:", err);
    // res.status(500).json({
    //   error: "Internal Server Error",
    //   message: "Authentication check failed.",
    // });
    next(err);
  }
};

export default apiKeyMiddleware;
