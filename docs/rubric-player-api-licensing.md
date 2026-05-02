# Rubric: Player API licensing (evidence matrix)

Maps rubric language for **licensing, keys, mediation, and operational controls** to **code and tests** in AmethystAPI, plus **consumer obligations** for [AmethystDraft](https://github.com/Team-Amethyst/AmethystDraft) (UI + `apps/api`).

## Mediation and deployment

| Rubric idea | AmethystAPI | AmethystDraft / ops |
|-------------|-------------|---------------------|
| Deployed separately | Engine is its own service (e.g. App Runner); see [README](../README.md) deployment. | Draft monorepo (`apps/web`, `apps/api`) deploys independently; see [amethystdraft-engine-integration.md](amethystdraft-engine-integration.md). |
| Complete mediation (no browser → Engine with secret) | Enforces **`x-api-key`** on licensed mounts only; does not serve Draft browser traffic with keys. | Browser → **Draft `apps/api` only** → Engine with `x-api-key` from server env. Documented in [draft-kit-license-runbook.md](draft-kit-license-runbook.md). |

## Engine enforcement chain (every licensed route)

Order in [`src/index.ts`](../src/index.ts): **`engineIpAllowlistMiddleware`** → **`apiKeyMiddleware`** → **`requireApiKeyScope(...)`** → **tier-aware `rateLimit`** (where mounted) → route handler.

| Rubric idea | Implementation | Tests / notes |
|-------------|----------------|---------------|
| API key required | [`src/middleware/apiKey.ts`](../src/middleware/apiKey.ts) — `401` / `403` / usage increment | [`test/apiKeyScope.test.ts`](../test/apiKeyScope.test.ts) (with key), integration patterns across valuation tests |
| Scopes | [`src/middleware/apiKeyScope.ts`](../src/middleware/apiKeyScope.ts) — per-mount scope (`valuation`, `catalog`, `scarcity`, `simulation`, `signals`) | [`test/apiKeyScope.test.ts`](../test/apiKeyScope.test.ts) |
| Three tiers of API keys | `tier` on `ApiKey`; [`src/middleware/tierRateLimits.ts`](../src/middleware/tierRateLimits.ts) + issue validation in [`src/routes/account.ts`](../src/routes/account.ts), [`src/routes/keyIssuance.ts`](../src/routes/keyIssuance.ts) | [`test/tierRateLimits.test.ts`](../test/tierRateLimits.test.ts) |
| Request throttling | [`src/middleware/engineRateLimit.ts`](../src/middleware/engineRateLimit.ts); `RATE_LIMIT_ENABLED`, per-route env ceilings | [`test/engineRateLimit.test.ts`](../test/engineRateLimit.test.ts) |
| IP address whitelisting (optional) | [`src/middleware/ipAllowlist.ts`](../src/middleware/ipAllowlist.ts) — `ENGINE_IP_ALLOWLIST`, `TRUST_PROXY` | No dedicated unit file; behavior documented in [README](../README.md); verify manually or add test when needed |
| Account tied to key generation | `developerAccountId` on keys; portal session mint via [`src/routes/account.ts`](../src/routes/account.ts) `issueMyKey`; [`src/routes/portalAuth.ts`](../src/routes/portalAuth.ts) links `PortalUser` → `DeveloperAccount` | Portal flows + `GET /api/usage` linkage (developer account block when key has account) |

## Portal vs product UI

| Rubric idea | Where it lives |
|-------------|------------------|
| Front-end for developer to create/manage account | AmethystAPI **`public/`** portal — `/api/auth/register`, `/api/auth/login`, `/api/account/*`. |
| Front-end for key generation (product) | Primarily **AmethystDraft** `apps/web` + server routes; Engine portal supplements for operators / graders. |
| `.env`, request use, license used properly | **AmethystDraft `apps/api`**: `AMETHYST_API_BASE_URL`, server-only key; never bundle `x-api-key` for browser → Engine calls. | [draft-kit-license-runbook.md](draft-kit-license-runbook.md), [amethystdraft-engine-integration.md](amethystdraft-engine-integration.md), [pre-deploy-testing-keys.md](pre-deploy-testing-keys.md) |

## Test case mapping (licensing slice of TC1)

See also [rubric-player-api-valuations.md](rubric-player-api-valuations.md) **TC1** row for the combined licensing + limits story.

| Concern | Primary tests |
|---------|----------------|
| Scope denial | `test/apiKeyScope.test.ts` |
| Tier rate limits | `test/tierRateLimits.test.ts`, `test/engineRateLimit.test.ts` |

## Related docs

- [RUBRIC_SUBMISSION_INDEX.md](RUBRIC_SUBMISSION_INDEX.md) — one-page index for reviewers.
- [openapi/openapi.yaml](../openapi/openapi.yaml) — public contract.
