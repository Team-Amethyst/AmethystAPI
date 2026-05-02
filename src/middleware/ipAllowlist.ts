import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../config/env";
import { ForbiddenError } from "../lib/appError";

/**
 * When `ENGINE_IP_ALLOWLIST` is non-empty, only those client IPs may call licensed engine routes.
 * Set `TRUST_PROXY=1` (default when allowlist is set) so `req.ip` reflects `X-Forwarded-For` behind App Runner / ALB.
 */
export function engineIpAllowlistMiddleware(): RequestHandler {
  const entries = env.engineIpAllowlist;
  if (entries.length === 0) {
    return (_req: Request, _res: Response, next: NextFunction) => {
      next();
    };
  }
  const allow = new Set(entries);
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ip = req.ip ?? "";
    if (!allow.has(ip)) {
      next(
        new ForbiddenError(
          "Client IP is not allowed to access the Amethyst Engine.",
          403,
          "IP_NOT_ALLOWLISTED"
        )
      );
      return;
    }
    next();
  };
}

export function engineIpAllowlistEnabled(): boolean {
  return env.engineIpAllowlistEnabled;
}
