# Valuation module map

This map documents where each pricing responsibility lives after the refactor.

## Core orchestrator

- `src/services/inflationEngine.ts`
  - Orchestrates request-scoped valuation flow end to end.
  - Handles player filtering, rank labels (Steal/Reach/Fair), row shaping, and response assembly.

## Row shaping and identity helpers

- `src/services/valuationRows.ts`
  - Deterministic value/ADP sorting helpers.
  - Per-row adjusted/baseline/inflation shaping with indicator assignment.
- `src/lib/playerId.ts`
  - Canonical player id resolution (`mlbId` fallback to `_id`).

## Inflation model branch logic

- `src/services/inflationModel.ts`
  - `computeBudgetRemaining`
  - `selectInflationModel` (`global_v1`, `surplus_slots_v1`, `replacement_slots_v2`)
  - `clampInflation`
  - `computeInflationIndexVsOpeningAuction`

## Recommended bid heuristics

- `src/services/recommendedBid.ts`
  - `computeRecommendedBid`
  - `smoothRecommendedBids`
  - `baseLambdaClearingPrice`
  - `isPitcherPosition`

## Team-adjusted valuation economics

- `src/services/teamAdjustedValue.ts`
  - User-team open slot accounting (`buildOpenSlotsForUserTeam`)
  - Budget / slot pressure helpers
  - Replacement-drop diagnostics
  - `teamAdjustedMultipliers` and `computeTeamAdjustedValue`

## Replacement model implementation

- `src/services/replacementSlotsV2.ts`
  - Slot-aware replacement allocation and surplus mass for v2.

## Catalog normalization and sync

- `src/lib/playerCatalog.ts`
  - Normalizes Mongo docs into `LeanPlayer` and hardens coercion.
- `scripts/sync-players.ts`
  - Syncs MLB splits to Mongo and preserves two-way eligibility (`positions[]`).
- `scripts/audit-player-eligibility.ts`
  - Post-sync QA script (`pnpm sync-players:verify`).

## Test coverage map

- `test/valuationWorkflow.test.ts` — workflow and output behavior.
- `test/replacementSlotsV2.test.ts` — v2 economics and slot fit rules.
- `test/inflationModel.test.ts` — extracted inflation-model helpers.
- `test/teamAdjustedValue.test.ts` — extracted team-adjusted helpers.
- `test/recommendedBid.test.ts` — extracted recommended-bid heuristics.
