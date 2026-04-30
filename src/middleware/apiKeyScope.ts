import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ForbiddenError } from "../lib/appError";
import {
  ALLOWED_API_KEY_SCOPES,
  type ApiKeyScope,
  normalizeScopes,
} from "../lib/apiKey";
import type { ApiKeyRequest } from "./apiKey";

/**
 * Keys must include the route scope. Empty/missing scopes on legacy keys default to full access.
 */
export function requireApiKeyScope(required: ApiKeyScope): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = req as ApiKeyRequest;
    const raw = r.apiKeyScopes;
    const effective: ApiKeyScope[] =
      raw == null || raw.length === 0
        ? [...ALLOWED_API_KEY_SCOPES]
        : normalizeScopes(raw);
    if (!effective.includes(required)) {
      next(
        new ForbiddenError(
          `This API key is not authorized for the "${required}" scope.`,
          403,
          "API_KEY_SCOPE_DENIED"
        )
      );
      return;
    }
    next();
  };
}
