import { Router, Request, Response, RequestHandler, NextFunction } from "express";
import ApiKey from "../models/ApiKey";
import {
  ALLOWED_API_KEY_SCOPES,
  ALLOWED_API_KEY_TIERS,
  generateApiKeySecret,
  hashApiKey,
  normalizeScopes,
  validateApiKeyFormat,
} from "../lib/apiKey";
import { ValidationError, NotFoundError } from "../lib/appError";

const router: Router = Router();

interface CreateApiKeyBody {
  label: string;
  owner: string;
  tier: string;
  scopes: unknown;
  expiresAt?: string;
}

const listKeys: RequestHandler = async (_req, res, next) => {
  try {
    const keys = await ApiKey.find()
      .sort({ createdAt: -1 })
      .lean();

    res.json(
      keys.map((doc) => ({
        id: doc._id,
        label: doc.label,
        owner: doc.owner,
        tier: doc.tier,
        scopes: doc.scopes,
        keyPrefix: doc.keyPrefix,
        createdAt: doc.createdAt,
        expiresAt: doc.expiresAt || null,
        lastUsed: doc.lastUsed || null,
        isActive: doc.isActive,
      }))
    );
  } catch (err) {
    next(err);
  }
};

const createKey: RequestHandler = async (req, res, next) => {
  const body = req.body as CreateApiKeyBody;

  if (!body || typeof body !== "object") {
    return next(new ValidationError("Request body must be a JSON object."));
  }

  const label = String(body.label || "").trim();
  const owner = String(body.owner || "").trim();
  const tier = String(body.tier || "").trim();
  const scopes = normalizeScopes(body.scopes);
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

  if (!label) {
    return next(new ValidationError("Key label is required.", 400, "KEY_LABEL_REQUIRED"));
  }
  if (!owner) {
    return next(new ValidationError("Owner name is required.", 400, "KEY_OWNER_REQUIRED"));
  }
  if (!ALLOWED_API_KEY_TIERS.includes(tier as any)) {
    return next(new ValidationError("Tier must be one of free, standard, or premium.", 400, "KEY_TIER_INVALID"));
  }
  if (scopes.length === 0) {
    return next(new ValidationError("At least one scope is required.", 400, "KEY_SCOPES_REQUIRED"));
  }
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return next(new ValidationError("Expiration date must be a valid date.", 400, "KEY_EXPIRES_INVALID"));
  }
  if (expiresAt && expiresAt <= new Date()) {
    return next(new ValidationError("Expiration date must be in the future.", 400, "KEY_EXPIRES_PAST"));
  }

  const { secret, keyPrefix } = generateApiKeySecret();
  const keyHash = hashApiKey(secret);

  try {
    const created = await ApiKey.create({
      keyHash,
      keyPrefix,
      label,
      owner,
      tier,
      scopes,
      expiresAt,
      isActive: true,
    });

    res.status(201).json({
      secret,
      id: created._id,
      label: created.label,
      owner: created.owner,
      tier: created.tier,
      scopes: created.scopes,
      keyPrefix: created.keyPrefix,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt || null,
      lastUsed: created.lastUsed || null,
      isActive: created.isActive,
    });
  } catch (err) {
    next(err);
  }
};

const revokeKey: RequestHandler = async (req, res, next) => {
  const keyId = req.params.id;

  if (!keyId) {
    return next(new ValidationError("API key identifier is required.", 400, "KEY_ID_REQUIRED"));
  }

  try {
    const updated = await ApiKey.findByIdAndUpdate(
      keyId,
      { isActive: false },
      { new: true, lean: true }
    );

    if (!updated) {
      return next(new NotFoundError("API key not found.", 404, "KEY_NOT_FOUND"));
    }

    res.json({
      id: updated._id,
      isActive: updated.isActive,
    });
  } catch (err) {
    next(err);
  }
};

router.get("/", listKeys);
router.post("/", createKey);
router.post("/:id/revoke", revokeKey);

export default router;
