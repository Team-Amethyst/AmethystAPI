import { Router, RequestHandler, NextFunction, Request, Response } from "express";
import ApiKey from "../models/ApiKey";
import {
  ServiceUnavailableError,
} from "../lib/appError";
import {
  ALLOWED_API_KEY_SCOPES,
  allocateUniqueKeyEmail,
  generateApiKeySecret,
  hashApiKey,
} from "../lib/apiKey";
import { resolveDeveloperAccount } from "../lib/developerAccounts";
import {
  assertIssuanceToken,
  issuanceEnabled,
  parseIssueBody,
} from "./keyIssuanceHelpers";

const router = Router();

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
    const {
      owner,
      tier,
      label,
      contactEmail,
      developerAccountIdRaw,
      organizationRaw,
    } = parseIssueBody(body);

    const email = allocateUniqueKeyEmail(contactEmail);
    const scopes = [...ALLOWED_API_KEY_SCOPES];
    const developerAccount = await resolveDeveloperAccount({
      developerAccountId: developerAccountIdRaw,
      owner,
      email: contactEmail,
      organization: organizationRaw,
    });

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
          developerAccountId: developerAccount._id,
          email,
          tier,
          scopes,
          expiresAt: null,
          isActive: true,
        });
        res.status(201).json({
          apiKey: secret,
          owner,
          developerAccountId: developerAccount._id,
          tier,
          label,
          email,
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
