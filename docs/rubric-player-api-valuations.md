# Rubric: Player API valuations (evidence matrix)

Maps rubric language to **concrete behavior** and **automated tests** in this repo. Use this for reviewers who need traceability without reading the whole codebase.

## Data contract (aggregator → engine)

| Rubric idea | Implementation | Notes |
|-------------|----------------|-------|
| Player value via aggregator | `POST /valuation/calculate` loads Mongo via [`PLAYER_CATALOG_LEAN_SELECT`](../src/lib/playerCatalogProjection.ts), normalizes with [`normalizeCatalogPlayers`](../src/lib/playerCatalog.ts), runs [`executeValuationWorkflow`](../src/services/valuationWorkflow.ts). | Single supported path for auction dollars. |
| Last-year vs predictive | **`stats`** = last completed MLB season only. **`projection`** = 5:3:2 three-year blend ([`mlbProjectionBlend.ts`](../src/lib/mlbProjectionBlend.ts)), written by [`scripts/sync-players.ts`](../scripts/sync-players.ts). `catalogMeta` on the document lists seasons. | Baseline roto/points reads `projection` ([`baselineProjectionStats.ts`](../src/services/baselineProjectionStats.ts)). |
| Age | Sync sets `age`; baseline uses [`baselineAgeDepthAdjustments.ts`](../src/services/baselineAgeDepthAdjustments.ts). | Catalog field `age`. |
| Depth chart | Sync sets `depthChartPosition`; same baseline module. | Heuristic from volume; override via Mongo if needed. |
| Injury | Optional `injurySeverity` (1–3) on catalog row; [`baselineInjuryAdjustments.ts`](../src/services/baselineInjuryAdjustments.ts) after age/depth. | Also [`/signals`](../src/routes/signals.ts) for news-style injury feeds (separate from catalog field). |
| Scarcity | [`scarcityEngine.ts`](../src/services/scarcityEngine.ts), replacement v2 / inflation in [`docs/valuation-module-map.md`](valuation-module-map.md). | |
| Fresh values after edits | **`POST /valuation/calculate` is not Redis-cached** (see [README](../README.md)). | [AmethystDraft](https://github.com/Team-Amethyst/AmethystDraft) should debounce and re-call on each meaningful draft edit (see [amethystdraft-engine-integration.md](amethystdraft-engine-integration.md)). |

## Test cases (TC1–TC5)

| ID | Rubric-style description | Primary evidence |
|----|-------------------------|------------------|
| **TC1** | **Licensing:** API key required, scopes enforced, tiers change rate limits | Code: [`src/middleware/apiKey.ts`](../src/middleware/apiKey.ts), [`apiKeyScope.ts`](../src/middleware/apiKeyScope.ts), [`tierRateLimits.ts`](../src/middleware/tierRateLimits.ts), [`engineRateLimit.ts`](../src/middleware/engineRateLimit.ts), [`index.ts`](../src/index.ts). Tests: [`test/apiKeyScope.test.ts`](../test/apiKeyScope.test.ts), [`test/tierRateLimits.test.ts`](../test/tierRateLimits.test.ts), [`test/engineRateLimit.test.ts`](../test/engineRateLimit.test.ts). |
| **TC2** | **Valuation success path:** checkpoint bodies return stable contract | [`test/valuationCalculate.integration.test.ts`](../test/valuationCalculate.integration.test.ts) (files under `test-fixtures/player-api/checkpoints/`), [`test/valuationWorkflow.test.ts`](../test/valuationWorkflow.test.ts). |
| **TC3** | **Variation / quality gates:** invalid economics or rows fail closed | [`test/valuationQuality.test.ts`](../test/valuationQuality.test.ts), [`test/valuationCalculate.handler422.test.ts`](../test/valuationCalculate.handler422.test.ts). |
| **TC4** | **Scarcity endpoint** | [`test/scarcity.integration.test.ts`](../test/scarcity.integration.test.ts). |
| **TC5** | **Calibration / manual benchmark** | [`test/valuationCalibration.test.ts`](../test/valuationCalibration.test.ts) + fixture `test-fixtures/valuation-calibration/manual-benchmark.json`. |

### Supporting unit tests (valuation building blocks)

- Age / depth: [`test/baselineAgeDepthAdjustments.test.ts`](../test/baselineAgeDepthAdjustments.test.ts), [`test/baselineValueEngine.test.ts`](../test/baselineValueEngine.test.ts).
- Injury: [`test/baselineInjuryAdjustments.test.ts`](../test/baselineInjuryAdjustments.test.ts).
- Multi-year blend math: [`test/mlbProjectionBlend.test.ts`](../test/mlbProjectionBlend.test.ts).
- Catalog coercion: [`test/playerCatalog.test.ts`](../test/playerCatalog.test.ts).
