# Rubric: Player API valuations (evidence matrix)

Maps rubric language to **concrete behavior** and **automated tests** in this repo. Use this for reviewers who need traceability without reading the whole codebase.

## Data contract (aggregator → engine)

| Rubric idea | Implementation | Notes |
|-------------|----------------|-------|
| Player value via aggregator | `POST /valuation/calculate` loads Mongo via [`PLAYER_CATALOG_LEAN_SELECT`](../src/lib/playerCatalogProjection.ts), normalizes with [`normalizeCatalogPlayers`](../src/lib/playerCatalog.ts), runs [`executeValuationWorkflow`](../src/services/valuationWorkflow.ts). Per-player **`auction_value`** is the canonical official dollar (equals **`adjusted_value`**; default **`inflation_model`** is **`replacement_slots_v2`**). **`recommended_bid`** is the suggested bid (clamped to **`max_bid`**, the team hard stop). | Single supported path for auction dollars. |
| Last-year vs predictive | **`stats`** = last completed MLB season only. **`projection`** = 5:3:2 three-year blend ([`mlbProjectionBlend.ts`](../src/lib/mlbProjectionBlend.ts)), written by [`scripts/sync-players.ts`](../scripts/sync-players.ts). `catalogMeta` on the document lists seasons. | Baseline roto/points reads `projection` ([`baselineProjectionStats.ts`](../src/services/baselineProjectionStats.ts)). |
| Age | Sync sets `age`; baseline uses [`baselineAgeDepthAdjustments.ts`](../src/services/baselineAgeDepthAdjustments.ts). | Catalog field `age`. **Explainability:** missing/invalid age → `age_multiplier` **1.0**; in-band “prime” ages → **1.04** (see tuning). |
| Depth chart | Sync sets `depthChartPosition`; same baseline module. | Heuristic from volume; override via Mongo if needed. **Explainability:** `baseline_components` / `valuation_explain` (when `explain_valuation_rows`) include `depth_chart_position_resolved`, `depth_multiplier`, and `age_depth_combined_multiplier` (age×depth product **clipped** 0.8–1.14). |
| Injury | Optional `injurySeverity` (1–3) on catalog row; [`baselineInjuryAdjustments.ts`](../src/services/baselineInjuryAdjustments.ts) **after** age/depth. | Also [`/signals`](../src/routes/signals.ts) for news-style injury feeds (separate from catalog field). **Explainability:** `injury_severity`, `injury_multiplier`, and `injury_component` (dollar delta) on rows; does not change formulas. |
| Scarcity | [`scarcityEngine.ts`](../src/services/scarcityEngine.ts), replacement v2 / inflation in [`docs/valuation-module-map.md`](valuation-module-map.md). | |
| Fresh values after edits | **`POST /valuation/calculate` is not Redis-cached** (see [README](../README.md)). | [AmethystDraft](https://github.com/Team-Amethyst/AmethystDraft) should debounce and re-call on each meaningful draft edit (see [amethystdraft-engine-integration.md](amethystdraft-engine-integration.md)). |

## Test cases (TC1–TC5)

| ID | Rubric-style description | Primary evidence |
|----|-------------------------|------------------|
| **TC1** | **Licensing:** API key required, scopes enforced, tiers change rate limits | Code: [`src/middleware/apiKey.ts`](../src/middleware/apiKey.ts), [`apiKeyScope.ts`](../src/middleware/apiKeyScope.ts), [`tierRateLimits.ts`](../src/middleware/tierRateLimits.ts), [`engineRateLimit.ts`](../src/middleware/engineRateLimit.ts), [`index.ts`](../src/index.ts). Tests: [`test/apiKeyScope.test.ts`](../test/apiKeyScope.test.ts), [`test/tierRateLimits.test.ts`](../test/tierRateLimits.test.ts), [`test/engineRateLimit.test.ts`](../test/engineRateLimit.test.ts). |
| **TC2** | **Valuation success path:** checkpoint bodies return stable contract | [`test/valuationCalculate.integration.test.ts`](../test/valuationCalculate.integration.test.ts) (files under `test-fixtures/player-api/checkpoints/`), [`test/valuationWorkflow.test.ts`](../test/valuationWorkflow.test.ts), [`test/maxBidSemantics.test.ts`](../test/maxBidSemantics.test.ts). |
| **TC3** | **Variation / quality gates:** invalid economics or rows fail closed | [`test/valuationQuality.test.ts`](../test/valuationQuality.test.ts), [`test/valuationCalculate.handler422.test.ts`](../test/valuationCalculate.handler422.test.ts). |
| **TC4** | **Scarcity endpoint** | [`test/scarcity.integration.test.ts`](../test/scarcity.integration.test.ts). |
| **TC5** | **Calibration / manual benchmark** | [`test/valuationCalibration.test.ts`](../test/valuationCalibration.test.ts) + fixture `test-fixtures/valuation-calibration/manual-benchmark.json`. |

### Supporting unit tests (valuation building blocks)

- Dollar ladder (identities + symmetric team collapse + isotonic bids): [`test/valuationDollarLadder.test.ts`](../test/valuationDollarLadder.test.ts); UX story: [valuation-dollar-ladder.md](valuation-dollar-ladder.md).
- Age / depth: [`test/baselineAgeDepthAdjustments.test.ts`](../test/baselineAgeDepthAdjustments.test.ts), [`test/baselineValueEngine.test.ts`](../test/baselineValueEngine.test.ts).
- Injury: [`test/baselineInjuryAdjustments.test.ts`](../test/baselineInjuryAdjustments.test.ts).
- Risk explain payload (baseline + `explain_valuation_rows`): [`test/valuationBaselineRiskExplain.test.ts`](../test/valuationBaselineRiskExplain.test.ts).
- Multi-year blend math: [`test/mlbProjectionBlend.test.ts`](../test/mlbProjectionBlend.test.ts).
- Catalog coercion: [`test/playerCatalog.test.ts`](../test/playerCatalog.test.ts).
