import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ForbiddenError } from "../lib/appError";

function parseAllowlist(): string[] | null {
  const raw = process.env.ENGINE_IP_ALLOWLIST?.trim();
  if (!raw) return null;
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * When `ENGINE_IP_ALLOWLIST` is non-empty, only those client IPs may call licensed engine routes.
 * Set `TRUST_PROXY=1` (default when allowlist is set) so `req.ip` reflects `X-Forwarded-For` behind App Runner / ALB.
 */
export function engineIpAllowlistMiddleware(): RequestHandler {
  const entries = parseAllowlist();
  if (entries == null || entries.length === 0) {
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
  const list = parseAllowlist();
  return list != null && list.length > 0;
}
