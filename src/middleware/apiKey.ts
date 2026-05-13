import { Request, Response, NextFunction } from "express";
import ApiKey from "../models/ApiKey";
import { getCached, setCache } from "../lib/redis";
import { UnauthorizedError, ForbiddenError } from "../lib/appError";
import { logger } from "../lib/logger";
import {
  API_KEY_PREFIX,
  hashApiKey,
  normalizeScopes,
  validateApiKeyFormat,
} from "../lib/apiKey";
import type { ApiKeyScope } from "../lib/apiKey";
import {
  getApiKeyMemoEntry,
  setApiKeyMemoEntry,
} from "../lib/apiKeyMemoryCache";

const CACHE_PREFIX = "ae:apikey:";
const CACHE_TTL_SECONDS = 60;

/** Attaches licensing metadata to the request after successful key validation. */
export interface ApiKeyRequest extends Request {
  apiKeyOwner?: string;
  apiKeyTier?: string;
  /** Normalized scopes from Mongo; empty means legacy key (treated as all scopes in scope middleware). */
  apiKeyScopes?: ApiKeyScope[];
}

type CachedKeyEnvelope = {
  owner: string;
  tier: string;
  isActive: boolean;
  scopes: unknown;
};

/**
 * Modern keys (`amethyst_live_<20hex>.<48hex>`) are issued through `keyIssuance.ts` which only
 * stores the hashed key. The legacy `ApiKey.findOne({ key })` lookup is exclusively for legacy
 * rows that pre-date hashing — there is **no** way for a modern-format key to match by raw
 * `key`. Skipping the second Mongo round-trip for modern keys removes a full Atlas RTT from the
 * hot path when Redis is down (production state 2026-05-13).
 */
function eligibleForLegacyKeyLookup(rawKey: string): boolean {
  return !rawKey.startsWith(`${API_KEY_PREFIX}_`);
}

/**
 * Validates the x-api-key header for every request to the Amethyst Engine.
 *
 * Lookup order (each layer fast-fails to the next):
 * 1. **In-process memo cache** — `getApiKeyMemoEntry` keyed by `hashApiKey(key)`. 60s TTL,
 *    LRU-bounded at 1k entries. Removes Mongo + Redis cost on hot keys.
 * 2. **Redis cache** (non-blocking, see `src/lib/redis.ts`) — coherent across instances.
 * 3. **Mongo `ApiKey.findOne({ keyHash })`** — authoritative.
 * 4. **Mongo legacy `ApiKey.findOne({ key })`** — only when format suggests it could be legacy.
 *
 * Usage tracking (`usageCount`, `lastUsed`) is fire-and-forget so it never blocks the hot path.
 */
const apiKeyMiddleware = async (
  req: ApiKeyRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const rawKey = req.headers["x-api-key"];

  if (!rawKey || typeof rawKey !== "string" || rawKey.trim() === "") {
    throw new UnauthorizedError(
      "A valid x-api-key header is required to access the Amethyst Engine API.",
      401,
      "API_KEY_MISSING"
    );
  }

  const key = rawKey.trim();

  if (!validateApiKeyFormat(key)) {
    throw new UnauthorizedError(
      "Invalid API key format.",
      401,
      "API_KEY_INVALID_FORMAT"
    );
  }

  try {
    const hashedKey = hashApiKey(key);

    const memHit = getApiKeyMemoEntry(hashedKey);
    if (memHit) {
      req.apiKeyOwner = memHit.owner;
      req.apiKeyTier = memHit.tier;
      req.apiKeyScopes = memHit.scopes;
      next();
      return;
    }

    const redisCacheKey = `${CACHE_PREFIX}${key}`;
    let cached = await getCached<CachedKeyEnvelope>(redisCacheKey);

    if (!cached) {
      let doc = await ApiKey.findOne({ keyHash: hashedKey }).lean();

      if (!doc && eligibleForLegacyKeyLookup(key)) {
        doc = await ApiKey.findOne({ key }).lean();
      }

      if (!doc) {
        throw new UnauthorizedError(
          "API key not recognized.",
          401,
          "API_KEY_NOT_FOUND"
        );
      }
      if (!doc.isActive) {
        throw new ForbiddenError(
          "API key has been deactivated.",
          403,
          "API_KEY_DEACTIVATED"
        );
      }
      if (doc.expiresAt && doc.expiresAt <= new Date()) {
        throw new ForbiddenError(
          "API key has expired.",
          403,
          "API_KEY_EXPIRED"
        );
      }

      cached = {
        owner: doc.owner,
        tier: doc.tier,
        isActive: doc.isActive,
        scopes: doc.scopes,
      };
      await setCache(redisCacheKey, cached, CACHE_TTL_SECONDS);

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

    const scopes = normalizeScopes(cached.scopes);
    setApiKeyMemoEntry(hashedKey, {
      owner: cached.owner,
      tier: cached.tier,
      isActive: cached.isActive,
      scopes,
    });

    req.apiKeyOwner = cached.owner;
    req.apiKeyTier = cached.tier;
    req.apiKeyScopes = scopes;
    next();
  } catch (err) {
    next(err);
  }
};

export default apiKeyMiddleware;
