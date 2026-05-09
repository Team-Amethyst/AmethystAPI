import type {
  LeanPlayer,
  NormalizedValuationInput,
  ValuationResponse,
} from "../types/brain";
import { attachValuationExplainability } from "../lib/valuationExplainability";
import { logger } from "../lib/logger";
import { validateValuationResponse } from "../lib/valuationQuality";
import { DEFAULT_INFLATION_MODEL } from "../lib/valuationDefaults";
import { positionOverridesFromRequest } from "../lib/fantasyRosterSlots";
import { calculateInflation } from "./inflationEngine";
import { scoringAwareBaselinePlayers } from "./baselineValueEngine";
import { filterValuationUniverse } from "../lib/valuationPlayerPool";
import { computeRemainingLeagueRosterSlots } from "../lib/remainingLeagueRosterSlots";
import { buildRosteredPlayersForSlotEngine } from "../lib/rosteredPlayersForSlots";

/**
 * Valuation pipeline (course UML activity diagram — first pass mapping)
 *
 * 1. **Read league settings & draft state** — Done upstream: `NormalizedValuationInput`
 *    from Draft/fixtures (roster_slots, scoring_categories, budgets, drafted_players, …).
 * 2. **Read eligible player data** — `LeanPlayer[]` from Mongo (`Player`); long-term this
 *    should carry 3-year stats, age, role, injury signals populated by your analytics/sync
 *    pipeline (not an external valuation API).
 * 3. **Valuation universe** — `filterValuationUniverse` (`league_scope`, optional
 *    `eligible_player_ids` / `excluded_player_ids`) before baseline z-scores and inflation.
 *    **Filter drafted** — inside `calculateInflation` (drafted ids, minors/taxi, etc.).
 *    Optional `player_ids` only limits **returned rows**; inflation basis follows **`inflation_model`**
 *    (`global_v1`, `surplus_slots_v1`, or `replacement_slots_v2`; default **`replacement_slots_v2`**; see `docs/valuation-inflation-semantics.md`).
 * 4. **Choose scoring system** — Branch on `scoring_format`: `points` vs category-style
 *    (`5x5` / `6x6` / default). Baseline dollars are projection- and category-driven; Mongo
 *    `value` is a weak prior via `catalogValuePrior`.
 * 5. **Per-player projection & surplus** — Projections + scoring categories set list baselines;
 *    inflation pass scales to remaining auction dollars (market condition).
 * 6. **Convert to auction dollars** — `calculateInflation` → `adjusted_value`.
 * 7. **Validate reasonableness** — `validateValuationResponse` (finite, non-negative $, enums).
 *    UML “retry / adjust parameters” loop: extend here (recompute with caps) when you add
 *    tunable model parameters.
 */
export type ScoringMode = "points" | "rotisserie_categories";

export function resolveScoringMode(
  input: NormalizedValuationInput
): ScoringMode {
  if (input.scoring_format === "points") {
    return "points";
  }
  return "rotisserie_categories";
}

export type ValuationWorkflowResult =
  | { ok: true; response: ValuationResponse }
  | { ok: false; issues: string[] };

type ExtraDraftContext = {
  additionalSpent: number;
  additionalDraftedIds: string[];
};

function extractDraftedIdsAndSpend(input: NormalizedValuationInput): ExtraDraftContext {
  const ids = new Set<string>();
  let spent = 0;

  const collectUnknownRows = (rows: unknown[] | undefined) => {
    for (const row of rows ?? []) {
      if (typeof row !== "object" || row == null) continue;
      const rec = row as Record<string, unknown>;
      const pid = rec.player_id;
      if (typeof pid === "string" && pid.length > 0) ids.add(pid);
      const keeperCost = rec.keeper_cost;
      const paid = rec.paid;
      if (typeof keeperCost === "number" && Number.isFinite(keeperCost)) {
        spent += keeperCost;
      } else if (typeof paid === "number" && Number.isFinite(paid)) {
        spent += paid;
      }
    }
  };

  const collectBuckets = (
    buckets: NormalizedValuationInput["minors"] | NormalizedValuationInput["taxi"]
  ) => {
    if (!buckets) return;
    if (Array.isArray(buckets)) {
      for (const bucket of buckets) {
        collectUnknownRows(bucket.players as unknown[]);
      }
      return;
    }
    for (const v of Object.values(buckets)) {
      if (Array.isArray(v)) collectUnknownRows(v);
    }
  };

  if (input.pre_draft_rosters) {
    for (const rows of Object.values(input.pre_draft_rosters)) {
      collectUnknownRows(Array.isArray(rows) ? rows : []);
    }
  }
  collectBuckets(input.minors);
  collectBuckets(input.taxi);
  return { additionalSpent: spent, additionalDraftedIds: [...ids] };
}

/**
 * Runs inflation + steal/reach on the current pool. Scoring mode is resolved for logging
 * and future per-format baseline math; today both paths use the same `calculateInflation`.
 *
 * Post-calculation sanity checks use **fail-closed** semantics: invalid output returns
 * `ok: false` so the HTTP layer can respond with **422** and no price payload.
 */
export function executeValuationWorkflow(
  allPlayers: LeanPlayer[],
  input: NormalizedValuationInput,
  scope: { playerId?: string; position?: string } = {},
  options: { debugSignals?: boolean } = {}
): ValuationWorkflowResult {
  const valuationPool = filterValuationUniverse(allPlayers, {
    leagueScope: input.league_scope,
    eligiblePlayerIds: input.eligible_player_ids,
    excludedPlayerIds: input.excluded_player_ids,
  });
  const positionOverrides = positionOverridesFromRequest(input.position_overrides);
  const basePlayers = scoringAwareBaselinePlayers(
    valuationPool,
    input.scoring_format,
    input.scoring_categories,
    input.roster_slots,
    positionOverrides
  );
  const extra = extractDraftedIdsAndSpend(input);
  const rosteredPlayersForSlots = buildRosteredPlayersForSlotEngine(input);
  const remainingLeagueSlots = computeRemainingLeagueRosterSlots(
    input.roster_slots,
    input.num_teams,
    input.drafted_players,
    extra.additionalDraftedIds
  );

  const retryPlan = [
    { inflationCap: 3.0, inflationFloor: 0.25 },
    { inflationCap: 3.0, inflationFloor: 0.35 },
    { inflationCap: 2.5, inflationFloor: 0.5 },
  ];
  let lastIssues: string[] = [];

  for (let i = 0; i < retryPlan.length; i++) {
    const pass = retryPlan[i];
    const response = calculateInflation(
      basePlayers,
      input.drafted_players,
      input.total_budget,
      input.num_teams,
      input.roster_slots,
      input.league_scope,
      {
        deterministic: input.deterministic,
        seed: input.seed,
        playerIdsFilter: input.player_ids,
        budgetByTeamId: input.budget_by_team_id,
        userTeamId: input.user_team_id,
        additionalSpent: extra.additionalSpent,
        additionalDraftedIds: extra.additionalDraftedIds,
        inflationCap: pass.inflationCap,
        inflationFloor: pass.inflationFloor,
        inflationModel: input.inflation_model ?? DEFAULT_INFLATION_MODEL,
        remainingLeagueSlots,
        rosteredPlayersForSlots,
        debugSignals: options.debugSignals,
        positionOverrides,
      }
    );

    const quality = validateValuationResponse(response);
    if (quality.ok) {
      if (i > 0) {
        logger.warn(
          { pass: i + 1, component: "valuationWorkflow" },
          "valuation recovered after bounded recompute"
        );
      }
      const explained = attachValuationExplainability(
        response,
        input,
        basePlayers,
        scope
      );
      return { ok: true, response: explained };
    }
    lastIssues = quality.issues;
  }

  logger.warn(
    { issues: lastIssues, component: "valuationWorkflow" },
    "valuation output validation failed (422)"
  );
  return { ok: false, issues: lastIssues };
}
