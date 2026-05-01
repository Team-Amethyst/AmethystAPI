import { Router, Request, Response, RequestHandler, NextFunction } from "express";
import ApiKey from "../models/ApiKey";
import DeveloperAccount from "../models/DeveloperAccount";
import { UnauthorizedError } from "../lib/appError";
import { hashApiKey, validateApiKeyFormat } from "../lib/apiKey";

const router: Router = Router();

/**
 * GET /api/usage
 *
 * Returns usage statistics for the provided x-api-key.
 * Safe to call from the developer dashboard — does NOT increment usageCount.
 */
const getUsage: RequestHandler = async (
  req: Request,
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

  let record;
  try {
    record = await ApiKey.findOne({ keyHash: hashApiKey(key) }).lean();
    if (!record) {
      record = await ApiKey.findOne({ key }).lean();
    }
  } catch (err) {
    return next(err);
  }

  if (!record) {
    throw new UnauthorizedError("API key not found.", 401, "API_KEY_NOT_FOUND");
  }

  let developerAccount: {
    id: string;
    displayName: string;
    organization: string | null;
    contactEmail: string | null;
  } | null = null;

  if (record.developerAccountId) {
    try {
      const dev = await DeveloperAccount.findById(record.developerAccountId).lean();
      if (dev && dev._id) {
        developerAccount = {
          id: String(dev._id),
          displayName: dev.displayName,
          organization: dev.organization ?? null,
          contactEmail: dev.contactEmail ?? null,
        };
      }
    } catch (err) {
      return next(err);
    }
  }

  res.json({
    label: record.label,
    owner: record.owner,
    email: record.email ?? null,
    tier: record.tier,
    scopes: record.scopes || [],
    keyPrefix: record.keyPrefix,
    usageCount: record.usageCount,
    lastUsed: record.lastUsed,
    createdAt: record.createdAt ?? null,
    expiresAt: record.expiresAt || null,
    isActive: record.isActive,
    developerAccount,
  });
};

router.get("/", getUsage);

export default router;
