import crypto from "crypto";
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

export type ExplainabilityScope = {
  playerId?: string;
  position?: string;
};

type CachedContext = NonNullable<ValuationResponse["context_v2"]> & {
  market_notes: string[];
};

const contextCache = new Map<string, CachedContext>();

function explainabilityCacheKey(
  response: ValuationResponse,
  input: NormalizedValuationInput,
  scope: ExplainabilityScope
): string {
  const payload = JSON.stringify({
    model: response.valuation_model_version ?? "unknown",
    inflationModel: response.inflation_model,
    inflation: response.inflation_factor,
    indexVsOpen: response.inflation_index_vs_opening_auction ?? null,
    inflationRaw: response.inflation_raw,
    inflationBounded: response.inflation_bounded_by,
    budget: response.total_budget_remaining,
    players: response.players_remaining,
    v2meta:
      response.inflation_model === "replacement_slots_v2"
        ? {
            remaining_slots: response.remaining_slots ?? null,
            surplus_cash: response.surplus_cash ?? null,
            total_surplus_mass: response.total_surplus_mass ?? null,
            draftable_pool_size: response.draftable_pool_size ?? null,
            fallback_reason: response.fallback_reason ?? null,
            repl: response.replacement_values_by_slot_or_position ?? null,
          }
        : null,
    leagueId: input.league_id ?? null,
    scope,
    drafted: input.drafted_players.map((d) => [
      d.player_id,
      d.team_id,
      d.paid ?? null,
    ]),
    budgets: input.budget_by_team_id ?? null,
    leagueScope: input.league_scope,
  });
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function sortPositionAlerts<T extends { severity: string; urgency_score: number; position: string }>(
  alerts: T[]
): T[] {
  return [...alerts].sort((a, b) => {
    const sevRank = { critical: 4, high: 3, medium: 2, low: 1 } as const;
    const bySeverity =
      (sevRank[b.severity as keyof typeof sevRank] ?? 0) -
      (sevRank[a.severity as keyof typeof sevRank] ?? 0);
    if (bySeverity !== 0) return bySeverity;
    const byUrgency = b.urgency_score - a.urgency_score;
    if (byUrgency !== 0) return byUrgency;
    return a.position.localeCompare(b.position);
  });
}

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

  const cached: CachedContext = { ...context, market_notes: marketNotes };
  contextCache.set(key, cached);
  if (contextCache.size > 200) {
    const oldest = contextCache.keys().next().value;
    if (oldest) contextCache.delete(oldest);
  }
  return cached;
}
