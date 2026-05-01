import { Router, RequestHandler } from "express";
import ApiKey from "../models/ApiKey";
import DeveloperAccount from "../models/DeveloperAccount";
import { ALLOWED_API_KEY_SCOPES, ALLOWED_API_KEY_TIERS, generateApiKeySecret, hashApiKey } from "../lib/apiKey";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "../lib/appError";
import { PortalRequest, requirePortalSession } from "../middleware/portalSession";
import { issuanceEnabled } from "./keyIssuanceHelpers";

const router = Router();

const me: RequestHandler = async (req, res, next) => {
  try {
    const portalUser = (req as PortalRequest).portalUser;
    if (!portalUser) {
      throw new ValidationError("Missing portal session context.", 500, "PORTAL_CONTEXT_MISSING");
    }
    const developerAccount = await DeveloperAccount.findById(portalUser.developerAccountId).lean();
    if (!developerAccount) {
      throw new NotFoundError("Developer account not found.", 404, "DEVELOPER_ACCOUNT_NOT_FOUND");
    }
    res.json({
      user: {
        id: portalUser.id,
        email: portalUser.email,
        displayName: portalUser.displayName,
      },
      developerAccount: {
        id: developerAccount._id,
        displayName: developerAccount.displayName,
        contactEmail: developerAccount.contactEmail ?? null,
        organization: developerAccount.organization ?? null,
        isActive: developerAccount.isActive,
      },
    });
  } catch (err) {
    next(err);
  }
};

const listMyKeys: RequestHandler = async (req, res, next) => {
  try {
    const portalUser = (req as PortalRequest).portalUser;
    if (!portalUser) {
      throw new ValidationError("Missing portal session context.", 500, "PORTAL_CONTEXT_MISSING");
    }

    const keys = await ApiKey.find({ developerAccountId: portalUser.developerAccountId })
      .sort({ createdAt: -1 })
      .lean();

    res.json(
      keys.map((doc) => ({
        id: doc._id,
        label: doc.label,
        owner: doc.owner,
        email: doc.email ?? null,
        tier: doc.tier,
        scopes: doc.scopes ?? [],
        keyPrefix: doc.keyPrefix,
        usageCount: doc.usageCount ?? 0,
        lastUsed: doc.lastUsed ?? null,
        createdAt: doc.createdAt ?? null,
        expiresAt: doc.expiresAt ?? null,
        isActive: doc.isActive,
      }))
    );
  } catch (err) {
    next(err);
  }
};

const issueMyKey: RequestHandler = async (req, res, next) => {
  try {
    if (!issuanceEnabled()) {
      throw new ServiceUnavailableError(
        "Key issuance is disabled on this server.",
        "KEY_ISSUANCE_DISABLED"
      );
    }
    const portalUser = (req as PortalRequest).portalUser;
    if (!portalUser) {
      throw new ValidationError("Missing portal session context.", 500, "PORTAL_CONTEXT_MISSING");
    }
    const body = req.body as Record<string, unknown>;
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const tierRaw = typeof body.tier === "string" ? body.tier.trim() : "free";
    const expiresAtRaw = typeof body.expiresAt === "string" ? body.expiresAt.trim() : "";

    if (!label) {
      throw new ValidationError("label is required.", 400, "KEY_LABEL_REQUIRED");
    }
    if (
      !ALLOWED_API_KEY_TIERS.includes(tierRaw as (typeof ALLOWED_API_KEY_TIERS)[number])
    ) {
      throw new ValidationError("tier must be free, standard, or premium.", 400, "KEY_TIER_INVALID");
    }

    let expiresAt: Date | null = null;
    if (expiresAtRaw) {
      expiresAt = new Date(expiresAtRaw);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new ValidationError("expiresAt must be a valid date.", 400, "KEY_EXPIRES_INVALID");
      }
      if (expiresAt <= new Date()) {
        throw new ValidationError("expiresAt must be in the future.", 400, "KEY_EXPIRES_PAST");
      }
    }

    const developerAccount = await DeveloperAccount.findById(portalUser.developerAccountId).lean();
    if (!developerAccount) {
      throw new NotFoundError("Developer account not found.", 404, "DEVELOPER_ACCOUNT_NOT_FOUND");
    }

    const { secret, keyPrefix } = generateApiKeySecret();
    const created = await ApiKey.create({
      keyHash: hashApiKey(secret),
      keyPrefix,
      label,
      owner: developerAccount.displayName,
      developerAccountId: developerAccount._id,
      email: developerAccount.contactEmail || undefined,
      tier: tierRaw,
      scopes: [...ALLOWED_API_KEY_SCOPES],
      expiresAt,
      isActive: true,
    });

    res.status(201).json({
      secret,
      id: created._id,
      label: created.label,
      owner: created.owner,
      developerAccountId: created.developerAccountId ?? null,
      tier: created.tier,
      scopes: created.scopes,
      keyPrefix: created.keyPrefix,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt || null,
      isActive: created.isActive,
      message: "Copy this key now. It will not be shown again.",
    });
  } catch (err) {
    next(err);
  }
};

router.get("/me", requirePortalSession, me);
router.get("/keys", requirePortalSession, listMyKeys);
router.post("/keys/issue", requirePortalSession, issueMyKey);

export default router;
