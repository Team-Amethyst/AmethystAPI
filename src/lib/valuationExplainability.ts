import crypto from "crypto";
import { analyzeScarcity } from "../services/scarcityEngine";
import {
  confidenceFromSeverity,
  recommendedActionForSeverity,
  severityFromUrgency,
} from "./explainabilityScoring";
import type {
  LeanPlayer,
  NormalizedValuationInput,
  ValuationResponse,
  ValuedPlayer,
} from "../types/brain";

type ContextScope = {
  playerId?: string;
  position?: string;
};

type CachedContext = NonNullable<ValuationResponse["context_v2"]> & {
  market_notes: string[];
};

const contextCache = new Map<string, CachedContext>();

function stripAlertPrefix(s: string): string {
  return s.replace(/^⚠️\s*/, "").trim();
}

type InflationHeadlineBasis = "neutral_1" | "opening_index";

function formatHeadline(
  f: number,
  topPosition: string | null,
  basis: InflationHeadlineBasis
): string {
  const pct = Math.round((f - 1) * 100);
  const vs =
    basis === "opening_index" ? "auction open" : "neutral";
  if (pct >= 12) {
    return topPosition
      ? `Market is inflated (+${pct}% vs ${vs}) and ${topPosition} is the top scarcity pressure point.`
      : `Market is inflated (+${pct}% vs ${vs}), so premium tiers are likely to clear above list value.`;
  }
  if (pct <= -12) {
    return topPosition
      ? `Market is deflated (${pct}% vs ${vs}) but ${topPosition} still shows scarcity pressure.`
      : `Market is deflated (${pct}% vs ${vs}), so disciplined value bidding should hold.`;
  }
  return topPosition
    ? `Market is near ${basis === "opening_index" ? "auction-open baseline" : "neutral"} and ${topPosition} is the key position to monitor.`
    : basis === "opening_index"
      ? "Market is near the auction-open baseline and value is broadly distributed across positions."
      : "Market is near neutral and value is broadly distributed across positions.";
}

function positionTokens(pos: string): string[] {
  return pos
    .split(/[,/]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function findPositionAlert(
  alerts: Array<{ position: string }>,
  position: string | undefined
): { position: string } | undefined {
  if (!position) return undefined;
  const tokens = positionTokens(position);
  for (const tok of tokens) {
    const match = alerts.find((a) => a.position.toUpperCase() === tok);
    if (match) return match;
  }
  return undefined;
}

function rounded(n: number): number {
  return Number(n.toFixed(2));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function cacheKey(
  response: ValuationResponse,
  input: NormalizedValuationInput,
  scope: ContextScope
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
    drafted: input.drafted_players.map((d) => [d.player_id, d.team_id, d.paid ?? null]),
    budgets: input.budget_by_team_id ?? null,
    leagueScope: input.league_scope,
  });
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function buildDriverRows(row: ValuedPlayer, response: ValuationResponse) {
  const inflationFactor = response.inflation_factor;
  const scarcityImpact = rounded(row.scarcity_adjustment ?? 0);
  const inflationImpact = rounded(row.inflation_adjustment ?? 0);
  const delta = rounded(row.adjusted_value - row.baseline_value);
  const otherImpact = rounded(delta - scarcityImpact - inflationImpact);
  const scFac = row.baseline_components?.scarcity_component ?? 0;
  const raw = response.inflation_raw;
  const bounded = response.inflation_bounded_by;
  const idxOpen = response.inflation_index_vs_opening_auction;
  let leagueReason =
    response.inflation_model === "replacement_slots_v2"
      ? `replacement_slots_v2: slot-aware surplus allocation (factor ${inflationFactor.toFixed(2)}× on marginal list $ above replacement); see response replacement_values_by_slot_or_position and fallback_reason.${
          idxOpen != null && Number.isFinite(idxOpen)
            ? ` Auction-open index ${idxOpen.toFixed(2)}× (1.0 = same allocator at replayed auction open).`
            : ""
        }`
      : `League-wide factor ${inflationFactor.toFixed(2)}× applied to list_value (baseline already includes scoring/roster scarcity).`;
  if (bounded === "cap") {
    leagueReason += ` Raw ratio was ${raw.toFixed(2)}× before the workflow cap.`;
  } else if (bounded === "floor") {
    leagueReason += ` Raw ratio was ${raw.toFixed(2)}× before the workflow floor.`;
  }
  const drivers = [
    {
      label: "League inflation",
      impact: inflationImpact,
      reason: leagueReason,
    },
    {
      label: `Scarcity context (${row.position})`,
      impact: scarcityImpact,
      reason:
        Math.abs(scFac) < 0.001
          ? "No roster scarcity multiplier on this row (see baseline_components)."
          : `Scarcity multiplier ${scFac.toFixed(3)} is embedded in list_value; scarcity_adjustment stays 0 so drivers reconcile to auction_target − list_value.`,
    },
    {
      label: "Other model effects",
      impact: otherImpact,
      reason:
        Math.abs(otherImpact) < 0.25
          ? "No residual; Steal/Reach comes from ADP vs value rank, not an extra dollar line item."
          : "Rounding residual only.",
    },
  ].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return { scarcityImpact, inflationImpact, otherImpact, drivers };
}

function buildPlayerWhy(
  row: ValuedPlayer,
  leagueInflation: number,
  scarcityByPos: Map<string, { score: number; alert: string | null }>
): string[] {
  const why: string[] = [];
  if (row.indicator === "Steal") {
    why.push(
      "Model ranks this player higher than ADP implies the market does — possible value."
    );
  } else if (row.indicator === "Reach") {
    why.push(
      "ADP is ahead of model rank — paying full sticker price may be risky."
    );
  } else {
    why.push("ADP and model auction value are broadly aligned.");
  }

  why.push(
    `Adjusted auction $${row.adjusted_value.toFixed(1)} vs baseline $${row.baseline_value.toFixed(1)} after league inflation (${leagueInflation.toFixed(2)}×).`
  );

  const scFac = row.baseline_components?.scarcity_component ?? 0;
  if (Number.isFinite(scFac) && Math.abs(scFac) >= 0.01) {
    why.push(
      `Roster/scarcity is reflected in baseline list price (scarcity_component=${scFac.toFixed(3)} on baseline_components), before the league inflation factor.`
    );
  }

  for (const tok of positionTokens(row.position)) {
    const sc = scarcityByPos.get(tok);
    if (sc && sc.score >= 60 && sc.alert) {
      why.push(`${tok}: ${stripAlertPrefix(sc.alert)}`);
      break;
    }
  }

  if ((row.tier || 99) <= 1 && leagueInflation > 1.08) {
    why.push("Elite tier in an inflated market — expect competitive bidding.");
  }

  return why;
}

/**
 * Adds human-readable **additive** fields for trust / UI (`market_notes`, per-row `why`).
 * Call only after output validation succeeds so pricing semantics stay fail-closed.
 */
export function attachValuationExplainability(
  response: ValuationResponse,
  input: NormalizedValuationInput,
  allPlayers: LeanPlayer[],
  scope: ContextScope = {}
): ValuationResponse {
  const selectedPositionFromRow =
    scope.playerId != null
      ? response.valuations.find((v) => v.player_id === scope.playerId)?.position
      : undefined;
  const effectiveScope: ContextScope = {
    ...scope,
    position: scope.position ?? selectedPositionFromRow,
  };

  const key = cacheKey(response, input, effectiveScope);
  let cached = contextCache.get(key);

  if (!cached) {
    const scarcity = analyzeScarcity(
      allPlayers,
      input.drafted_players,
      input.num_teams,
      input.scoring_categories,
      input.league_scope
    );
    const sortedAlerts = scarcity.positions
      .map((p) => {
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
      .sort((a, b) => {
        const sevRank = { critical: 4, high: 3, medium: 2, low: 1 };
        const bySeverity = sevRank[b.severity] - sevRank[a.severity];
        if (bySeverity !== 0) return bySeverity;
        const byUrgency = b.urgency_score - a.urgency_score;
        if (byUrgency !== 0) return byUrgency;
        return a.position.localeCompare(b.position);
      });

    const top = sortedAlerts[0] ?? null;
    const idx = response.inflation_index_vs_opening_auction;
    const headlineBasis: InflationHeadlineBasis =
      response.inflation_model === "replacement_slots_v2" &&
      idx != null &&
      Number.isFinite(idx)
        ? "opening_index"
        : "neutral_1";
    const headlineF =
      headlineBasis === "opening_index" ? idx! : response.inflation_factor;
    const pctNeutral = Math.round((response.inflation_factor - 1) * 100);
    const pctVsAuctionOpen =
      idx != null && Number.isFinite(idx)
        ? Math.round((idx - 1) * 100)
        : undefined;
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
      ...scarcity.monopoly_warnings
        .slice(0, 2)
        .map((w) => stripAlertPrefix(w.message)),
    ];

    cached = { ...context, market_notes: marketNotes };
    contextCache.set(key, cached);
    if (contextCache.size > 200) {
      const oldest = contextCache.keys().next().value;
      if (oldest) contextCache.delete(oldest);
    }
  }

  const scarcityByPos = new Map(
    cached.position_alerts.map((p) => [
      p.position.toUpperCase(),
      { score: p.urgency_score, alert: p.message },
    ])
  );

  const valuations = response.valuations.map((row) => ({
    ...row,
    why: buildPlayerWhy(row, response.inflation_factor, scarcityByPos),
    explain_v2: (() => {
      const { scarcityImpact, inflationImpact, otherImpact, drivers } = buildDriverRows(
        row,
        response
      );
      const indicatorConfidence =
        row.indicator === "Fair Value"
          ? 0.7
          : row.indicator === "Steal"
            ? 0.78
            : 0.74;
      return {
        indicator: row.indicator,
        auction_target: row.adjusted_value,
        list_value: row.baseline_value,
        adjustments: {
          scarcity: scarcityImpact,
          inflation: inflationImpact,
          other: otherImpact,
        },
        drivers,
        confidence: clamp01(indicatorConfidence),
      };
    })(),
  }));

  const idxTop = response.inflation_index_vs_opening_auction;
  const pctAuctionTop =
    idxTop != null && Number.isFinite(idxTop)
      ? Math.round((idxTop - 1) * 100)
      : undefined;

  return {
    ...response,
    ...(pctAuctionTop != null
      ? { inflation_percent_vs_auction_open: pctAuctionTop }
      : {}),
    market_notes: cached.market_notes,
    context_v2: {
      ...cached,
      scope: {
        ...cached.scope,
        position: effectiveScope.position ?? cached.scope.position,
      },
    },
    valuations,
  };
}
