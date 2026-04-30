# Valuation module map

This map documents where each pricing responsibility lives after the refactor.

## Core orchestrator

- `src/services/inflationEngine.ts`
  - Orchestrates request-scoped valuation flow end to end.
  - Handles player filtering, rank labels (Steal/Reach/Fair), row shaping, and response assembly.

## Post-inflation row passes

- `src/services/inflationPostProcess.ts`
  - Draft phase from league slot fill.
  - `recommended_bid` pass (depth ordering + optional `debug_v2` lambda/replacement lines).
  - `team_adjusted_value` + `edge` pass (symmetric-open collapse lives here).

## Row shaping and identity helpers

- `src/services/valuationRows.ts`
  - Deterministic value/ADP sorting helpers.
  - Per-row adjusted/baseline/inflation shaping with indicator assignment.
- `src/lib/playerId.ts`
  - Canonical player id resolution (`mlbId` fallback to `_id`).

## Baseline (catalog → list $ before inflation)

- `src/services/baselineValueEngine.ts` — `scoringAwareBaselinePlayers` (roto z-score vs points vs scarcity-only fallback).
- `src/services/baselineProjectionStats.ts` — projection field reads, category weights/directions, pooled mean/stddev helpers; pitcher detection uses `playerTokensFromLean` (aligned with slot logic / two-way eligibility).
- `src/services/baselineAgeDepthAdjustments.ts` — age-curve and depth-chart priors with explicit tuning constants and fallback depth proxy behavior.

## Request parsing (valuation calculate)

- `src/lib/valuationRequestSchemas.ts` — Zod schemas for flat vs nested bodies.
- `src/lib/valuationRequestNormalization.ts` — map parsed payloads → `NormalizedValuationInput`.
- `src/lib/valuationRequest.ts` — `parseValuationRequest` / economics validation entrypoints.

## Fantasy roster slots

- `src/lib/fantasyPositioning.ts` — tokenization, hitter/pitcher checks, slot fit rules.
- `src/lib/fantasySlotAssignment.ts` — league demand, greedy assignment, replacement levels, surplus max.
- `src/lib/fantasyRosterSlots.ts` — **barrel** re-export (stable import path for callers).

## Shared TypeScript contracts

- `src/types/brain.ts` — re-exports domain types for a single import surface.
- `src/types/core.ts`, `src/types/valuation.ts`, … — split files by domain to keep each file small.

## Inflation model branch logic

- `src/services/inflationPrimitives.ts` — budget remaining, surplus-slice plan (`tryBuildSurplusPlan`), and inflation clamp math (shared with opening-auction index replay).
- `src/services/inflationModel.ts` — `selectInflationModel` (`global_v1`, `surplus_slots_v1`, `replacement_slots_v2`) and `computeInflationIndexVsOpeningAuction` (re-exports primitives for a single import surface).

## Recommended bid heuristics

- `src/services/recommendedBidConfig.ts` — heuristic/tuning constants for bid guidance.
- `src/services/recommendedBidMath.ts` — shared math primitives (`baseLambdaClearingPrice`, isotonic smoothing, pitcher position check).
- `src/services/recommendedBid.ts`
  - `computeRecommendedBid`
  - `smoothRecommendedBids`
  - Re-exports `baseLambdaClearingPrice` / `isPitcherPosition` for import stability.

## Team-adjusted valuation economics

- `src/services/teamAdjustedConfig.ts` — slot priority and starting-slot rules.
- `src/services/teamAdjustedNeed.ts` — positional need multiplier from open-slot state.
- `src/services/teamAdjustedValue.ts`
  - User-team open slot accounting (`buildOpenSlotsForUserTeam`)
  - Budget / slot pressure helpers
  - Replacement-drop diagnostics
  - `teamAdjustedMultipliers` and `computeTeamAdjustedValue`

## Replacement model implementation

- `src/services/replacementSlotsV2.ts` — `computeReplacementSlotsV2` orchestration (greedy fill, draftable pool, surplus mass).
- `src/services/replacementSlotsV2Types.ts` — result type for v2 runs.
- `src/services/replacementSlotsV2Config.ts` — min bid and per-slot replacement percentiles.
- `src/services/replacementSlotsV2Compare.ts` — deterministic sort tie-break for slot assignment candidates.

## Catalog normalization and sync

- `src/lib/playerCatalog.ts`
  - Normalizes Mongo docs into `LeanPlayer` and hardens coercion.
- `scripts/sync-players.ts`
  - Syncs MLB splits to Mongo, preserves two-way eligibility (`positions[]`), and persists coarse `depthChartPosition` priors.
- `scripts/audit-player-eligibility.ts`
  - Post-sync QA script (`pnpm sync-players:verify`).

## Replay + simulation helpers

- `src/services/mockPickEngine.ts` — mock pick orchestration over pool + team needs.
- `src/services/mockPickHelpers.ts` — slot-fit and team-needs calculations used by simulation.
- `src/lib/replayMongoFixtureMerge.ts` — fixture/Mongo identity merge orchestrator.
- `src/lib/replayMongoNameMatching.ts` — folded-name key expansion + alias matching utilities.

## Explainability (additive UI fields)

- `src/lib/valuationExplainability.ts` — public entry (`attachValuationExplainability`).
- `src/lib/valuationExplainabilityHelpers.ts` — string/formatting + per-row driver construction.
- `src/lib/valuationExplainabilityContext.ts` — cached `context_v2` + `market_notes` assembly (scarcity scan).

## Output validation + scarcity analytics

- `src/lib/valuationQualityConstants.ts` — enum sets / finite-number guards for response QC.
- `src/lib/valuationQualityRows.ts` — per-row pricing sanity checks.
- `src/lib/valuationQuality.ts` — response-level post-condition validator entrypoint.
- `src/services/scarcityConfig.ts` — scarcity constants and category stat-path mapping.
- `src/services/scarcityHelpers.ts` — positional scarcity/tier buckets + monopoly warning builders.
- `src/services/scarcityEngine.ts` — orchestration and response assembly.

## Test coverage map

- `test/valuationWorkflow.test.ts` — workflow and output behavior.
- `test/replacementSlotsV2.test.ts` — v2 economics and slot fit rules.
- `test/inflationModel.test.ts` — extracted inflation-model helpers.
- `test/teamAdjustedValue.test.ts` — extracted team-adjusted helpers.
- `test/recommendedBid.test.ts` — extracted recommended-bid heuristics.
