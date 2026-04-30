import { timingSafeEqual } from "crypto";
import type { Request } from "express";
import type { ApiKeyTier } from "../models/ApiKey";
import { ValidationError, UnauthorizedError } from "../lib/appError";
import { ALLOWED_API_KEY_TIERS } from "../lib/apiKey";

type ParsedIssueBody = {
  owner: string;
  tier: ApiKeyTier;
  label: string;
  contactEmail: string | null;
  developerAccountIdRaw: unknown;
  organizationRaw: unknown;
};

/** Issuance is on by default (portal + course deploys). */
export function issuanceEnabled(raw = process.env.KEY_ISSUANCE_ENABLED): boolean {
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  if (v === "") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function assertIssuanceToken(req: Request): void {
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

export function parseIssueBody(body: Record<string, unknown>): ParsedIssueBody {
  const ownerRaw = body.owner;
  const emailRaw = body.email;
  const tierRaw = body.tier;
  const developerAccountIdRaw = body.developerAccountId;
  const organizationRaw = body.organization;

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
  let contactEmail: string | null = null;
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
      contactEmail = e.toLowerCase();
    }
  }

  return {
    owner,
    tier,
    label,
    contactEmail,
    developerAccountIdRaw,
    organizationRaw,
  };
}
