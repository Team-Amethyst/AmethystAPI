import { analyzeScarcity } from "../services/scarcityEngine";
import type { LeanPlayer, NormalizedValuationInput, ValuationResponse } from "../types/brain";
import {
  confidenceFromSeverity,
  recommendedActionForSeverity,
  severityFromUrgency,
} from "./explainabilityScoring";
import {
  findPositionAlert,
  formatHeadline,
  rounded,
  stripAlertPrefix,
  type InflationHeadlineBasis,
} from "./valuationExplainabilityHelpers";
import {
  explainabilityCacheKey,
  sortPositionAlerts,
  upsertCachedContext,
  type CachedExplainabilityContext as CachedContext,
  type ExplainabilityScope,
} from "./valuationExplainabilityCache";

export type { ExplainabilityScope } from "./valuationExplainabilityCache";

const contextCache = new Map<string, CachedContext>();

/**
 * Cached league/market context used by `attachValuationExplainability` (expensive scarcity scan).
 */
export function getOrBuildExplainabilityContext(params: {
  response: ValuationResponse;
  input: NormalizedValuationInput;
  allPlayers: LeanPlayer[];
  effectiveScope: ExplainabilityScope;
}): CachedContext {
  const { response, input, allPlayers, effectiveScope } = params;
  const key = explainabilityCacheKey(response, input, effectiveScope);
  const hit = contextCache.get(key);
  if (hit) return hit;

  const scarcity = analyzeScarcity(
    allPlayers,
    input.drafted_players,
    input.num_teams,
    input.scoring_categories,
    input.league_scope
  );
  const sortedAlerts = sortPositionAlerts(
    scarcity.positions.map((p) => {
      const urgency = p.scarcity_score;
      const severity = severityFromUrgency(urgency);
      return {
        position: p.position,
        severity,
        urgency_score: urgency,
        message:
          p.alert != null
            ? stripAlertPrefix(p.alert)
            : `${p.position} supply is stable at the moment.`,
        evidence: {
          elite_remaining: p.elite_remaining,
          mid_tier_remaining: p.mid_tier_remaining,
          total_remaining: p.total_remaining,
        },
        recommended_action: recommendedActionForSeverity(severity, p.position),
      };
    })
  );

  const top = sortedAlerts[0] ?? null;
  const idx = response.inflation_index_vs_opening_auction;
  const headlineBasis: InflationHeadlineBasis =
    response.inflation_model === "replacement_slots_v2" &&
    idx != null &&
    Number.isFinite(idx)
      ? "opening_index"
      : "neutral_1";
  const headlineF = headlineBasis === "opening_index" ? idx! : response.inflation_factor;
  const pctNeutral = Math.round((response.inflation_factor - 1) * 100);
  const pctVsAuctionOpen =
    idx != null && Number.isFinite(idx) ? Math.round((idx - 1) * 100) : undefined;
  const confidenceOverall = top
    ? confidenceFromSeverity(top.severity, scarcity.monopoly_warnings.length)
    : 0.7;

  const context: NonNullable<ValuationResponse["context_v2"]> = {
    schema_version: "2",
    calculated_at: response.calculated_at,
    scope: {
      league_id: input.league_id ?? "unknown",
      player_id: effectiveScope.playerId,
      position: effectiveScope.position,
    },
    market_summary: {
      headline: formatHeadline(headlineF, top?.position ?? null, headlineBasis),
      inflation_factor: rounded(response.inflation_factor),
      inflation_raw: rounded(response.inflation_raw),
      inflation_bounded_by: response.inflation_bounded_by,
      inflation_percent_vs_neutral: pctNeutral,
      ...(pctVsAuctionOpen != null
        ? {
            inflation_percent_vs_auction_open: pctVsAuctionOpen,
            inflation_index_vs_opening_auction: rounded(idx!),
          }
        : {}),
      budget_left: rounded(response.total_budget_remaining),
      players_left: response.players_remaining,
      model_version: response.valuation_model_version ?? "unknown",
    },
    position_alerts: sortedAlerts,
    assumptions: [
      response.inflation_model === "replacement_slots_v2"
        ? `Auction inflation used replacement_slots_v2: greedy league-wide slot fill yields per-slot replacement baselines; surplus cash maps to value above replacement (see docs/valuation-inflation-semantics.md).${
            idx != null && Number.isFinite(idx)
              ? ` inflation_percent_vs_auction_open and inflation_index_vs_opening_auction (${idx.toFixed(2)}×) describe change vs a replayed auction-open state; inflation_percent_vs_neutral is always (inflation_factor−1)×100 (allocator vs 1.0, not "list neutral").`
              : ""
          }`
        : response.inflation_model === "surplus_slots_v1"
          ? "Auction inflation used surplus_slots_v1: $1 per remaining empty roster slot is reserved; surplus cash is mapped through value above replacement in a top draftable slice (see docs/valuation-inflation-semantics.md)."
          : "Auction inflation used global_v1: remaining budget is divided by the full undrafted pool baseline list dollars.",
      "The inflation factor may be clamped to a workflow floor/cap when list dollars versus remaining cash are extreme.",
      ...(response.inflation_bounded_by !== "none"
        ? [
            `This response used inflation_raw=${response.inflation_raw.toFixed(4)} before clamp; applied factor is ${response.inflation_factor.toFixed(4)} (${response.inflation_bounded_by}).`,
          ]
        : []),
      "Scarcity urgency uses remaining elite and mid-tier supply versus league demand.",
      "Draft state is treated as stateless full-context input for every request.",
      "players_remaining is always the count of the full undrafted pool; valuations.length may be smaller when player_ids filters the response.",
      response.inflation_model === "replacement_slots_v2"
        ? "pool_value_remaining equals total_surplus_mass (sum of marginal surplus $ in the slot-assigned draftable pool)."
        : response.inflation_model === "surplus_slots_v1"
          ? "pool_value_remaining is the sum of max(0, baseline − replacement) over the draftable inflation slice, not full-wire list dollars."
          : "pool_value_remaining sums baseline list dollars on all undrafted players (the global_v1 denominator).",
      "Real auction accuracy depends on catalog value quality and id/name alignment with the player pool.",
      "recommended_bid is a clearing-style guide (phase- and list-informed); it is not framed as the exact price the room will pay—compare to adjusted_value and team_adjusted_value for surplus vs roster context.",
    ],
    confidence: {
      overall: confidenceOverall,
      notes:
        scarcity.monopoly_warnings.length > 0
          ? "Category concentration is present; team-level behavior can increase volatility."
          : undefined,
    },
  };

  const selectedAlert = findPositionAlert(
    context.position_alerts,
    effectiveScope.position
  ) as
    | (typeof context.position_alerts extends Array<infer T> ? T : never)
    | undefined;
  const prioritizedAlerts = selectedAlert
    ? [
        selectedAlert,
        ...context.position_alerts
          .filter((a) => a.position !== selectedAlert.position)
          .slice(0, 2),
      ]
    : context.position_alerts.slice(0, 3);

  const marketNotes = [
    context.market_summary.headline,
    ...prioritizedAlerts.map((a) => `${a.position}: ${a.message}`),
    ...scarcity.monopoly_warnings.slice(0, 2).map((w) => stripAlertPrefix(w.message)),
  ];

  return upsertCachedContext(contextCache, key, {
    ...context,
    market_notes: marketNotes,
  });
}
