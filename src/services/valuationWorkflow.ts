import type { LeanPlayer, NormalizedValuationInput, ValuationResponse } from "../types/brain";
import { validateValuationResponse } from "../lib/valuationQuality";
import { calculateInflation } from "./inflationEngine";

/**
 * Valuation pipeline (course UML activity diagram — first pass mapping)
 *
 * 1. **Read league settings & draft state** — Done upstream: `NormalizedValuationInput`
 *    from Draft/fixtures (roster_slots, scoring_categories, budgets, drafted_players, …).
 * 2. **Read eligible player data** — `LeanPlayer[]` from Mongo (`Player`); long-term this
 *    should carry 3-year stats, age, role, injury signals populated by your analytics/sync
 *    pipeline (not an external valuation API).
 * 3. **Filter drafted / ineligible** — Inside `calculateInflation` (drafted ids + league_scope).
 * 4. **Choose scoring system** — Branch on `scoring_format`: `points` vs category-style
 *    (`5x5` / `6x6` / default rotisserie-style). **v1:** Baseline auction $ still come from
 *    `LeanPlayer.value` (your model’s output in DB). Per-system stat→dollar conversion is
 *    the next increment (replace or rescale `value` before inflation).
 * 5. **Per-player projection & surplus** — Encoded in stored `value`, `tier`, `projection`;
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

/**
 * Runs inflation + steal/reach on the current pool. Scoring mode is resolved for logging
 * and future per-format baseline math; today both paths use the same `calculateInflation`.
 *
 * Post-calculation sanity checks use **fail-closed** semantics: invalid output returns
 * `ok: false` so the HTTP layer can respond with **422** and no price payload.
 */
export function executeValuationWorkflow(
  allPlayers: LeanPlayer[],
  input: NormalizedValuationInput
): ValuationWorkflowResult {
  const response = calculateInflation(
    allPlayers,
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
    }
  );

  const quality = validateValuationResponse(response);
  if (!quality.ok) {
    console.warn(
      `[valuation] output validation failed (422): ${quality.issues.join("; ")}`
    );
    return { ok: false, issues: quality.issues };
  }

  return { ok: true, response };
}
