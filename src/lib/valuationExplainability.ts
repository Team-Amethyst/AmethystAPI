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

function formatHeadline(f: number, topPosition: string | null): string {
  const pct = Math.round((f - 1) * 100);
  if (pct >= 12) {
    return topPosition
      ? `Market is inflated (+${pct}% vs neutral) and ${topPosition} is the top scarcity pressure point.`
      : `Market is inflated (+${pct}% vs neutral), so premium tiers are likely to clear above list value.`;
  }
  if (pct <= -12) {
    return topPosition
      ? `Market is deflated (${pct}% vs neutral) but ${topPosition} still shows scarcity pressure.`
      : `Market is deflated (${pct}% vs neutral), so disciplined value bidding should hold.`;
  }
  return topPosition
    ? `Market is near neutral and ${topPosition} is the key position to monitor.`
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
    inflation: response.inflation_factor,
    budget: response.total_budget_remaining,
    players: response.players_remaining,
    leagueId: input.league_id ?? null,
    scope,
    drafted: input.drafted_players.map((d) => [d.player_id, d.team_id, d.paid ?? null]),
    budgets: input.budget_by_team_id ?? null,
    leagueScope: input.league_scope,
  });
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function buildDriverRows(row: ValuedPlayer, inflationFactor: number) {
  const scarcityImpact = rounded(row.scarcity_adjustment ?? 0);
  const inflationImpact = rounded(row.inflation_adjustment ?? 0);
  const delta = rounded(row.adjusted_value - row.baseline_value);
  const otherImpact = rounded(delta - scarcityImpact - inflationImpact);
  const scFac = row.baseline_components?.scarcity_component ?? 0;
  const drivers = [
    {
      label: "League inflation",
      impact: inflationImpact,
      reason: `League-wide factor ${inflationFactor.toFixed(2)}× applied to list_value (baseline already includes scoring/roster scarcity).`,
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
    const pctNeutral = Math.round((response.inflation_factor - 1) * 100);
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
        headline: formatHeadline(response.inflation_factor, top?.position ?? null),
        inflation_factor: rounded(response.inflation_factor),
        inflation_percent_vs_neutral: pctNeutral,
        budget_left: rounded(response.total_budget_remaining),
        players_left: response.players_remaining,
        model_version: response.valuation_model_version ?? "unknown",
      },
      position_alerts: sortedAlerts,
      assumptions: [
        "Auction inflation is computed from remaining budget divided by remaining pool value.",
        "The inflation factor may be clamped to a workflow floor/cap when pool list dollars are extreme versus remaining cash.",
        "Scarcity urgency uses remaining elite and mid-tier supply versus league demand.",
        "Draft state is treated as stateless full-context input for every request.",
        "pool_value_remaining sums baseline list dollars on undrafted players; real auction accuracy depends on catalog value quality — run `pnpm run audit:valuation-response` for fixture QA.",
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
        response.inflation_factor
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

  return {
    ...response,
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
