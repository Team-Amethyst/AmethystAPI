import { Router, RequestHandler } from "express";
import { ConflictError, ValidationError } from "../lib/appError";
import DeveloperAccount from "../models/DeveloperAccount";
import PortalUser from "../models/PortalUser";
import {
  PORTAL_SESSION_COOKIE,
  hashPortalPassword,
  issuePortalSessionToken,
  sessionCookieOptions,
  validatePortalPassword,
  verifyPortalPassword,
} from "../lib/portalAuth";
import { resolveDeveloperAccount } from "../lib/developerAccounts";
import { PortalRequest, requirePortalSession } from "../middleware/portalSession";

const router = Router();

function emailValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const register: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const organization = typeof body.organization === "string" ? body.organization.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!displayName) {
      throw new ValidationError("displayName is required.", 400, "PORTAL_DISPLAY_NAME_REQUIRED");
    }
    if (!email || !emailValid(email)) {
      throw new ValidationError("Valid email is required.", 400, "PORTAL_EMAIL_INVALID");
    }
    validatePortalPassword(password);

    const existing = await PortalUser.findOne({ email }).lean();
    if (existing) {
      throw new ConflictError("An account already exists for this email.", 409, "PORTAL_EMAIL_TAKEN");
    }

    const developerAccount = await resolveDeveloperAccount({
      owner: displayName,
      email,
      organization: organization || undefined,
    });
    const { passwordHash, passwordSalt } = hashPortalPassword(password);
    const user = await PortalUser.create({
      email,
      displayName,
      passwordHash,
      passwordSalt,
      developerAccountId: developerAccount._id,
      isActive: true,
      lastLoginAt: new Date(),
    });

    const token = issuePortalSessionToken(String(user._id));
    res.cookie(PORTAL_SESSION_COOKIE, token, sessionCookieOptions());
    res.status(201).json({
      user: {
        id: user._id,
        email: user.email,
        displayName: user.displayName,
      },
      developerAccount: {
        id: developerAccount._id,
        displayName: developerAccount.displayName,
        contactEmail: developerAccount.contactEmail ?? null,
        organization: developerAccount.organization ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
};

const login: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      throw new ValidationError(
        "email and password are required.",
        400,
        "PORTAL_LOGIN_FIELDS_REQUIRED"
      );
    }

    const user = await PortalUser.findOne({ email });
    if (!user || !user.isActive) {
      throw new ValidationError("Invalid email or password.", 401, "PORTAL_LOGIN_INVALID");
    }
    if (!verifyPortalPassword(password, user.passwordSalt, user.passwordHash)) {
      throw new ValidationError("Invalid email or password.", 401, "PORTAL_LOGIN_INVALID");
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = issuePortalSessionToken(String(user._id));
    res.cookie(PORTAL_SESSION_COOKIE, token, sessionCookieOptions());

    const developerAccount = await DeveloperAccount.findById(user.developerAccountId).lean();
    res.json({
      user: {
        id: user._id,
        email: user.email,
        displayName: user.displayName,
      },
      developerAccount: developerAccount
        ? {
            id: developerAccount._id,
            displayName: developerAccount.displayName,
            contactEmail: developerAccount.contactEmail ?? null,
            organization: developerAccount.organization ?? null,
            isActive: developerAccount.isActive,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
};

const logout: RequestHandler = async (_req, res) => {
  res.clearCookie(PORTAL_SESSION_COOKIE, {
    ...sessionCookieOptions(),
    maxAge: undefined,
  });
  res.status(204).send();
};

const me: RequestHandler = async (req, res, next) => {
  try {
    const portalUser = (req as PortalRequest).portalUser;
    if (!portalUser) {
      throw new ValidationError("Missing portal session context.", 500, "PORTAL_CONTEXT_MISSING");
    }
    const developerAccount = await DeveloperAccount.findById(portalUser.developerAccountId).lean();
    res.json({
      user: {
        id: portalUser.id,
        email: portalUser.email,
        displayName: portalUser.displayName,
      },
      developerAccount: developerAccount
        ? {
            id: developerAccount._id,
            displayName: developerAccount.displayName,
            contactEmail: developerAccount.contactEmail ?? null,
            organization: developerAccount.organization ?? null,
            isActive: developerAccount.isActive,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
};

router.post("/register", register);
router.post("/login", login);
router.post("/logout", logout);
router.get("/me", requirePortalSession, me);

export default router;
