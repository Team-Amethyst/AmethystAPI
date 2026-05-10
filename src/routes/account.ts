import { Router, RequestHandler } from "express";
import mongoose from "mongoose";
import ApiKey from "../models/ApiKey";
import DeveloperAccount from "../models/DeveloperAccount";
import { ALLOWED_API_KEY_SCOPES, ALLOWED_API_KEY_TIERS, generateApiKeySecret, hashApiKey } from "../lib/apiKey";
import { openPortalApiKeySecret, sealPortalApiKeySecret } from "../lib/portalApiKeySecret";
import {
  NotFoundError,
  ServiceUnavailableError,
  UpstreamError,
  ValidationError,
} from "../lib/appError";
import { logger } from "../lib/logger";
import {
  postCustomWebhookPayload,
  resolveBearerForStoredKey,
} from "../services/draftNewsSignalsWebhook";
import { isAllowedNewsSignalsWebhookUrl } from "../lib/newsSignalsWebhookUrl";
import { PortalRequest, requirePortalSession } from "../middleware/portalSession";
import { issuanceEnabled } from "./keyIssuanceHelpers";

/** Max JSON.stringify(payload).length for portal “send custom webhook” requests. */
const MAX_PORTAL_WEBHOOK_PAYLOAD_CHARS = 16_384;

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
      .select("+key +newsSignalsWebhookBearerSealed")
      .lean();

    res.json(
      keys.map((doc) => {
        const sealed = typeof doc.key === "string" && doc.key.length > 0 ? doc.key : null;
        const secret = sealed ? openPortalApiKeySecret(sealed) : null;
        return {
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
          newsSignalsWebhookUrl:
            typeof doc.newsSignalsWebhookUrl === "string" &&
            doc.newsSignalsWebhookUrl.length > 0
              ? doc.newsSignalsWebhookUrl
              : null,
          /** Whether a dedicated Bearer is stored (not the API key). Never exposes the secret. */
          usesDedicatedWebhookBearer: Boolean(doc.newsSignalsWebhookBearerSealed),
          /** Full secret when stored for this account (newer keys); legacy rows may omit. */
          secret: secret ?? null,
        };
      })
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
    const sealedSecret = sealPortalApiKeySecret(secret);
    const created = await ApiKey.create({
      keyHash: hashApiKey(secret),
      key: sealedSecret,
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
      message: "Key saved to your account. You can use it from the API keys and Playground pages when signed in.",
    });
  } catch (err) {
    next(err);
  }
};

const patchNewsSignalsWebhook: RequestHandler = async (req, res, next) => {
  try {
    const portalUser = (req as PortalRequest).portalUser;
    if (!portalUser) {
      throw new ValidationError("Missing portal session context.", 500, "PORTAL_CONTEXT_MISSING");
    }
    const rawId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!rawId || !mongoose.isValidObjectId(rawId)) {
      throw new ValidationError("Invalid key id.", 400, "KEY_ID_INVALID");
    }

    const body = req.body as Record<string, unknown>;
    const urlIn = body.newsSignalsWebhookUrl;
    const bearerIn = body.newsSignalsWebhookBearer;

    if (urlIn === undefined && bearerIn === undefined) {
      throw new ValidationError(
        "Provide newsSignalsWebhookUrl (null to clear) and/or newsSignalsWebhookBearer.",
        400,
        "WEBHOOK_FIELDS_MISSING"
      );
    }

    const keyDoc = await ApiKey.findOne({
      _id: new mongoose.Types.ObjectId(rawId),
      developerAccountId: portalUser.developerAccountId,
    }).select("+key +newsSignalsWebhookBearerSealed");

    if (!keyDoc) {
      throw new NotFoundError("API key not found.", 404, "API_KEY_NOT_FOUND");
    }

    const scopes = keyDoc.scopes ?? [];
    if (!scopes.includes("signals")) {
      throw new ValidationError(
        "API key must include the signals scope to register a news-signals webhook.",
        400,
        "KEY_SCOPE_SIGNALS_REQUIRED"
      );
    }

    if (
      urlIn !== undefined &&
      urlIn !== null &&
      typeof urlIn !== "string"
    ) {
      throw new ValidationError(
        "newsSignalsWebhookUrl must be a string or null.",
        400,
        "WEBHOOK_URL_TYPE"
      );
    }

    if (
      bearerIn !== undefined &&
      bearerIn !== null &&
      typeof bearerIn !== "string"
    ) {
      throw new ValidationError(
        "newsSignalsWebhookBearer must be a string or null.",
        400,
        "WEBHOOK_BEARER_TYPE"
      );
    }

    if (
      urlIn === null ||
      (typeof urlIn === "string" && urlIn.trim() === "")
    ) {
      keyDoc.newsSignalsWebhookUrl = null;
      keyDoc.newsSignalsWebhookBearerSealed = null;
      await keyDoc.save();
      res.json({
        id: keyDoc._id,
        newsSignalsWebhookUrl: null,
        usesDedicatedWebhookBearer: false,
      });
      return;
    }

    if (urlIn === undefined && bearerIn !== undefined) {
      const existingUrl = (keyDoc.newsSignalsWebhookUrl ?? "").trim();
      if (!existingUrl) {
        throw new ValidationError(
          "Set newsSignalsWebhookUrl before configuring Bearer.",
          400,
          "WEBHOOK_URL_REQUIRED_FIRST"
        );
      }
    }

    if (typeof urlIn === "string" && urlIn.trim().length > 0) {
      const trimmed = urlIn.trim();
      if (!isAllowedNewsSignalsWebhookUrl(trimmed)) {
        throw new ValidationError(
          "newsSignalsWebhookUrl must be https (http allowed only for localhost when NODE_ENV=production).",
          400,
          "WEBHOOK_URL_INVALID"
        );
      }
      keyDoc.newsSignalsWebhookUrl = trimmed;
    }

    if (bearerIn !== undefined) {
      if (bearerIn === null || bearerIn === "") {
        keyDoc.newsSignalsWebhookBearerSealed = null;
      } else if (typeof bearerIn === "string" && bearerIn.trim().length > 0) {
        keyDoc.newsSignalsWebhookBearerSealed = sealPortalApiKeySecret(
          bearerIn.trim()
        );
      } else {
        keyDoc.newsSignalsWebhookBearerSealed = null;
      }
    }

    const urlFinal = (keyDoc.newsSignalsWebhookUrl ?? "").trim();
    if (urlFinal.length > 0) {
      const hasDedicated = Boolean(keyDoc.newsSignalsWebhookBearerSealed);
      const apiKeyPlain =
        keyDoc.key != null ? openPortalApiKeySecret(keyDoc.key) : null;
      if (!hasDedicated && !apiKeyPlain) {
        throw new ValidationError(
          "Cannot authenticate webhook: set newsSignalsWebhookBearer to a secret your server validates, or use an API key minted with stored secret from this portal.",
          400,
          "WEBHOOK_BEARER_UNAVAILABLE"
        );
      }
    }

    await keyDoc.save();

    res.json({
      id: keyDoc._id,
      newsSignalsWebhookUrl: keyDoc.newsSignalsWebhookUrl ?? null,
      usesDedicatedWebhookBearer: Boolean(keyDoc.newsSignalsWebhookBearerSealed),
    });
  } catch (err) {
    next(err);
  }
};

const sendNewsSignalsWebhookMessage: RequestHandler = async (req, res, next) => {
  try {
    const portalUser = (req as PortalRequest).portalUser;
    if (!portalUser) {
      throw new ValidationError("Missing portal session context.", 500, "PORTAL_CONTEXT_MISSING");
    }
    const rawId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!rawId || !mongoose.isValidObjectId(rawId)) {
      throw new ValidationError("Invalid key id.", 400, "KEY_ID_INVALID");
    }

    const body = req.body as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(body, "payload")) {
      throw new ValidationError(
        "JSON body must include a `payload` object (any JSON-serializable value).",
        400,
        "WEBHOOK_PAYLOAD_MISSING"
      );
    }
    const payload = body.payload;

    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      throw new ValidationError("payload must be JSON-serializable.", 400, "WEBHOOK_PAYLOAD_SERIALIZE");
    }
    if (serialized.length > MAX_PORTAL_WEBHOOK_PAYLOAD_CHARS) {
      throw new ValidationError(
        `payload JSON must be at most ${MAX_PORTAL_WEBHOOK_PAYLOAD_CHARS} characters.`,
        400,
        "WEBHOOK_PAYLOAD_TOO_LARGE"
      );
    }

    const keyDoc = await ApiKey.findOne({
      _id: new mongoose.Types.ObjectId(rawId),
      developerAccountId: portalUser.developerAccountId,
    }).select("+key +newsSignalsWebhookBearerSealed");

    if (!keyDoc) {
      throw new NotFoundError("API key not found.", 404, "API_KEY_NOT_FOUND");
    }

    const scopes = keyDoc.scopes ?? [];
    if (!scopes.includes("signals")) {
      throw new ValidationError(
        "API key must include the signals scope.",
        400,
        "KEY_SCOPE_SIGNALS_REQUIRED"
      );
    }

    const url = (keyDoc.newsSignalsWebhookUrl ?? "").trim();
    if (!url) {
      throw new ValidationError(
        "Save a webhook URL for this key before sending.",
        400,
        "WEBHOOK_URL_REQUIRED"
      );
    }

    const bearer = resolveBearerForStoredKey(keyDoc);
    if (!bearer) {
      throw new ValidationError(
        "Cannot authenticate webhook: configure Bearer or use a portal-minted key with stored secret.",
        400,
        "WEBHOOK_BEARER_UNAVAILABLE"
      );
    }

    try {
      const result = await postCustomWebhookPayload(url, bearer, payload);
      logger.info(
        {
          component: "PortalWebhookSend",
          keyPrefix: keyDoc.keyPrefix,
          status: result.status,
          ok: result.ok,
        },
        "Portal custom webhook POST completed"
      );
      let webhookHost: string | null = null;
      try {
        webhookHost = new URL(url).host;
      } catch {
        webhookHost = null;
      }
      res.json({
        ok: result.ok,
        status: result.status,
        webhookHost,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: msg, component: "PortalWebhookSend", keyPrefix: keyDoc.keyPrefix },
        "Portal custom webhook POST failed"
      );
      throw new UpstreamError(
        `Could not reach webhook: ${msg}`,
        502,
        "WEBHOOK_DELIVERY_FAILED",
        { cause: msg }
      );
    }
  } catch (err) {
    next(err);
  }
};

const deleteMyKey: RequestHandler = async (req, res, next) => {
  try {
    const portalUser = (req as PortalRequest).portalUser;
    if (!portalUser) {
      throw new ValidationError("Missing portal session context.", 500, "PORTAL_CONTEXT_MISSING");
    }
    const rawId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!rawId || !mongoose.isValidObjectId(rawId)) {
      throw new ValidationError("Invalid key id.", 400, "KEY_ID_INVALID");
    }
    const result = await ApiKey.deleteOne({
      _id: new mongoose.Types.ObjectId(rawId),
      developerAccountId: portalUser.developerAccountId,
    });
    if (result.deletedCount === 0) {
      throw new NotFoundError("API key not found.", 404, "API_KEY_NOT_FOUND");
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

router.get("/me", requirePortalSession, me);
router.get("/keys", requirePortalSession, listMyKeys);
router.post("/keys/issue", requirePortalSession, issueMyKey);
router.patch(
  "/keys/:id/news-signals-webhook",
  requirePortalSession,
  patchNewsSignalsWebhook
);
router.post(
  "/keys/:id/news-signals-webhook/send",
  requirePortalSession,
  sendNewsSignalsWebhookMessage
);
router.delete("/keys/:id", requirePortalSession, deleteMyKey);

export default router;
