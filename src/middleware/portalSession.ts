import { RequestHandler } from "express";
import PortalUser from "../models/PortalUser";
import {
  PORTAL_SESSION_COOKIE,
  parseCookieValue,
  verifyPortalSessionToken,
} from "../lib/portalAuth";
import { UnauthorizedError } from "../lib/appError";

export interface PortalSessionUser {
  id: string;
  email: string;
  displayName: string;
  developerAccountId: string;
  isActive: boolean;
}

export type PortalRequest = Parameters<RequestHandler>[0] & {
  portalUser?: PortalSessionUser;
};

export const requirePortalSession: RequestHandler = async (req, _res, next) => {
  try {
    const cookieToken = parseCookieValue(req.headers.cookie, PORTAL_SESSION_COOKIE);
    const bearer = req.get("authorization");
    const bearerToken =
      typeof bearer === "string" && bearer.toLowerCase().startsWith("bearer ")
        ? bearer.slice(7).trim()
        : null;
    const token = cookieToken || bearerToken;
    if (!token) {
      throw new UnauthorizedError("Sign in is required.", 401, "PORTAL_SESSION_MISSING");
    }

    const { userId } = verifyPortalSessionToken(token);
    const user = await PortalUser.findById(userId).lean();
    if (!user || !user.isActive) {
      throw new UnauthorizedError("Account is unavailable.", 401, "PORTAL_ACCOUNT_INACTIVE");
    }

    (req as PortalRequest).portalUser = {
      id: String(user._id),
      email: user.email,
      displayName: user.displayName,
      developerAccountId: String(user.developerAccountId),
      isActive: user.isActive,
    };
    next();
  } catch (err) {
    next(err);
  }
};
