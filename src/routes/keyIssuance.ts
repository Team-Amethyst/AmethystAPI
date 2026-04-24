import { Router, RequestHandler, NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import ApiKey from "../models/ApiKey";
import type { ApiKeyTier } from "../models/ApiKey";
import {
  ValidationError,
  UnauthorizedError,
  ServiceUnavailableError,
} from "../lib/appError";
import {
  ALLOWED_API_KEY_SCOPES,
  ALLOWED_API_KEY_TIERS,
  generateApiKeySecret,
  hashApiKey,
} from "../lib/apiKey";

const router = Router();

/** Issuance is on by default (portal + course deploys). Set KEY_ISSUANCE_ENABLED=0|false|off to disable. */
function issuanceEnabled(): boolean {
  const raw = process.env.KEY_ISSUANCE_ENABLED;
  if (raw === undefined || raw === null) {
    return true;
  }
  const v = String(raw).trim().toLowerCase();
  if (v === "") {
    return true;
  }
  if (v === "0" || v === "false" || v === "no" || v === "off") {
    return false;
  }
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function assertIssuanceToken(req: Request): void {
  const secret = process.env.KEY_ISSUANCE_SECRET?.trim();
  if (!secret) return;

  const token = req.get("x-key-issuance-token");
  if (!token || typeof token !== "string") {
    throw new UnauthorizedError(
      "This server requires an issuance token. Ask your operator for X-Key-Issuance-Token.",
      401,
      "KEY_ISSUANCE_TOKEN_MISSING"
    );
  }

  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(token.trim(), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedError("Invalid issuance token.", 401, "KEY_ISSUANCE_TOKEN_INVALID");
  }
}

/**
 * GET /api/keys/status
 * Lets the developer portal show whether one-off issuance is available.
 */
const getStatus: RequestHandler = (_req, res) => {
  res.json({
    issuanceEnabled: issuanceEnabled(),
    requiresToken: Boolean(process.env.KEY_ISSUANCE_SECRET?.trim()),
  });
};

/**
 * POST /api/keys/issue
 *
 * Creates a hashed API key (same storage shape as POST /api/keys). Returns the plaintext secret once.
 */
const postIssue: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!issuanceEnabled()) {
      throw new ServiceUnavailableError(
        "Key issuance is disabled on this server. An operator must set KEY_ISSUANCE_ENABLED=1.",
        "KEY_ISSUANCE_DISABLED"
      );
    }

    assertIssuanceToken(req);

    const body = req.body as Record<string, unknown>;
    const ownerRaw = body.owner;
    const emailRaw = body.email;
    const tierRaw = body.tier;

    if (typeof ownerRaw !== "string" || ownerRaw.trim().length === 0) {
      throw new ValidationError(
        "owner is required — use a short label for this key (e.g. your app or team name).",
        400,
        "VALIDATION_FAILED"
      );
    }
    const owner = ownerRaw.trim();
    if (owner.length > 200) {
      throw new ValidationError("owner must be at most 200 characters.", 400, "VALIDATION_FAILED");
    }

    let tier: ApiKeyTier = "free";
    if (tierRaw !== undefined && tierRaw !== null && tierRaw !== "") {
      if (typeof tierRaw !== "string" || !ALLOWED_API_KEY_TIERS.includes(tierRaw as ApiKeyTier)) {
        throw new ValidationError(
          `tier must be one of: ${ALLOWED_API_KEY_TIERS.join(", ")}.`,
          400,
          "VALIDATION_FAILED"
        );
      }
      tier = tierRaw as ApiKeyTier;
    }

    let label = owner;
    if (emailRaw !== undefined && emailRaw !== null && emailRaw !== "") {
      if (typeof emailRaw !== "string") {
        throw new ValidationError("email must be a string when provided.", 400, "VALIDATION_FAILED");
      }
      const e = emailRaw.trim();
      if (e.length > 254) {
        throw new ValidationError("email is too long.", 400, "VALIDATION_FAILED");
      }
      if (e.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        throw new ValidationError("email format looks invalid.", 400, "VALIDATION_FAILED");
      }
      if (e.length > 0) {
        label = `${owner} (${e})`.slice(0, 200);
      }
    }

    const scopes = [...ALLOWED_API_KEY_SCOPES];

    const maxAttempts = 5;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { secret, keyPrefix } = generateApiKeySecret();
      const keyHash = hashApiKey(secret);
      try {
        await ApiKey.create({
          keyHash,
          keyPrefix,
          label,
          owner,
          tier,
          scopes,
          expiresAt: null,
          isActive: true,
        });
        res.status(201).json({
          apiKey: secret,
          owner,
          tier,
          label,
          keyPrefix,
          scopes,
          message:
            "Store this key now. It will not be shown again. There is no account recovery for lost keys.",
        });
        return;
      } catch (err: unknown) {
        lastErr = err;
        const code =
          err && typeof err === "object" && "code" in err
            ? (err as { code?: number }).code
            : undefined;
        if (code === 11000) {
          continue;
        }
        next(err);
        return;
      }
    }
    next(lastErr);
  } catch (err) {
    next(err);
  }
};

router.get("/status", getStatus);
router.post("/issue", postIssue);

export default router;
