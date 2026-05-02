import type { Express, RequestHandler, Router } from "express";
import type { ApiKeyScope } from "../lib/apiKey";
import apiKeyMiddleware from "../middleware/apiKey";
import { requireApiKeyScope } from "../middleware/apiKeyScope";
import { engineIpAllowlistMiddleware } from "../middleware/ipAllowlist";

const licensedStackBase = [
  engineIpAllowlistMiddleware(),
  apiKeyMiddleware,
] as const;

export type LicensedEngineMount = {
  /** Legacy path, e.g. `/valuation` */
  legacyPath: string;
  /** Versioned alias, e.g. `/v1/valuation` */
  v1Path: string;
  scope: ApiKeyScope;
  /** Omitted for routes that do not use express-rate-limit (e.g. scarcity). */
  rateLimiter?: () => RequestHandler;
  router: Router;
};

function stackFor(m: LicensedEngineMount): RequestHandler[] {
  const rl = m.rateLimiter?.();
  return [
    ...licensedStackBase,
    requireApiKeyScope(m.scope),
    ...(rl ? [rl] : []),
    m.router,
  ];
}

/** Registers licensed Brain routes at both legacy and `/v1` paths with identical middleware order. */
export function mountLicensedEngineRoutes(
  app: Express,
  mounts: LicensedEngineMount[]
): void {
  for (const m of mounts) {
    const handlers = stackFor(m);
    app.use(m.legacyPath, ...handlers);
    app.use(m.v1Path, ...handlers);
  }
}
