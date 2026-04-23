import { Request, Response, NextFunction } from "express";
import ApiKey from "../models/ApiKey";
import { getCached, setCache } from "../lib/redis";
import { UnauthorizedError, ForbiddenError } from "../lib/appError";
import { logger } from "../lib/logger";
import { hashApiKey, validateApiKeyFormat } from "../lib/apiKey";

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
    throw new UnauthorizedError("A valid x-api-key header is required to access the Amethyst Engine API.", 401, "API_KEY_MISSING");
  }

  const key = rawKey.trim();

  if (!validateApiKeyFormat(key)) {
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
      const hashedKey = hashApiKey(key);
      let doc = await ApiKey.findOne({ keyHash: hashedKey }).lean();

      if (!doc) {
        doc = await ApiKey.findOne({ key: key }).lean();
      }

      if (!doc) {
        throw new UnauthorizedError("API key not recognized.", 401, "API_KEY_NOT_FOUND");
      }
      if (!doc.isActive) {
        throw new ForbiddenError("API key has been deactivated.", 403, "API_KEY_DEACTIVATED");
      }
      if (doc.expiresAt && doc.expiresAt <= new Date()) {
        throw new ForbiddenError("API key has expired.", 403, "API_KEY_EXPIRED");
      }

      cached = { owner: doc.owner, tier: doc.tier, isActive: doc.isActive };
      await setCache(cacheKey, cached, CACHE_TTL_SECONDS);

      if (!doc.keyHash && doc.key === key) {
        ApiKey.findByIdAndUpdate(doc._id, {
          $set: { keyHash: hashApiKey(key) },
          $unset: { key: "" },
        }).catch((err: Error) =>
          logger.warn({ err: err.message }, "ApiKey migration warning")
        );
      }

      ApiKey.findOneAndUpdate(
        { _id: doc._id },
        { $inc: { usageCount: 1 }, $set: { lastUsed: new Date() } }
      ).catch((err: Error) =>
        logger.warn({ err: err.message }, "ApiKey usage tracking error")
      );
    }

    req.apiKeyOwner = cached.owner;
    req.apiKeyTier = cached.tier;
    next();
  } catch (err) {
    next(err);
  }
};

export default apiKeyMiddleware;
