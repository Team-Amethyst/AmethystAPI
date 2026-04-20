import type {
  LeanPlayer,
  NormalizedValuationInput,
  ValuationResponse,
} from "../types/brain";
import { attachValuationExplainability } from "../lib/valuationExplainability";
import { logger } from "../lib/logger";
import { validateValuationResponse } from "../lib/valuationQuality";
import { calculateInflation } from "./inflationEngine";
import { scoringAwareBaselinePlayers } from "./baselineValueEngine";

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
  scope: { playerId?: string; position?: string } = {}
): ValuationWorkflowResult {
  const basePlayers = scoringAwareBaselinePlayers(
    allPlayers,
    input.scoring_format,
    input.scoring_categories,
    input.roster_slots
  );
  const extra = extractDraftedIdsAndSpend(input);

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
        additionalSpent: extra.additionalSpent,
        additionalDraftedIds: extra.additionalDraftedIds,
        inflationCap: pass.inflationCap,
        inflationFloor: pass.inflationFloor,
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
