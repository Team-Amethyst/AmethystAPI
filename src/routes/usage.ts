import { Router, Request, Response, RequestHandler, NextFunction } from "express";
import ApiKey from "../models/ApiKey";
import { UnauthorizedError } from "../lib/appError";

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
    // res.status(401).json({ error: "x-api-key header is required." });
    // return;
    throw new UnauthorizedError("A valid x-api-key header is required to access the Amethyst Engine API.", 401, "API_KEY_MISSING");
  }

  const key = rawKey.trim();

  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
    // res.status(401).json({ error: "Invalid API key format." });
    // return;
    throw new UnauthorizedError("Invalid API key format.", 401, "API_KEY_INVALID_FORMAT");
  }

  let record;
  try {
    record = await ApiKey.findOne({ key }).lean();
  } catch (err) {
    // res.status(500).json({ error: "Database error. Please try again." });
    // return;
    next(err);
  }

  if (!record) {
    // res.status(401).json({ error: "API key not found." });
    // return;
    throw new UnauthorizedError("API key not found.", 401, "API_KEY_NOT_FOUND");
  }

  res.json({
    owner: record.owner,
    email: record.email ?? null,
    tier: record.tier,
    usageCount: record.usageCount,
    lastUsed: record.lastUsed,
    createdAt: record.createdAt ?? null,
    isActive: record.isActive,
  });
};

router.get("/", getUsage);

export default router;
