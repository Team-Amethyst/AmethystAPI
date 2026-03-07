import { Router, Request, Response, RequestHandler } from "express";
import ApiKey from "../models/ApiKey";

const router: Router = Router();

/**
 * GET /api/usage
 *
 * Returns usage statistics for the provided x-api-key.
 * Safe to call from the developer dashboard — does NOT increment usageCount.
 */
const getUsage: RequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawKey = req.headers["x-api-key"];

  if (!rawKey || typeof rawKey !== "string" || rawKey.trim() === "") {
    res.status(401).json({ error: "x-api-key header is required." });
    return;
  }

  const key = rawKey.trim();

  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
    res.status(401).json({ error: "Invalid API key format." });
    return;
  }

  let record;
  try {
    record = await ApiKey.findOne({ key }).lean();
  } catch {
    res.status(500).json({ error: "Database error. Please try again." });
    return;
  }

  if (!record) {
    res.status(401).json({ error: "API key not found." });
    return;
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
