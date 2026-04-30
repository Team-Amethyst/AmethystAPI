import {
  buildDriverRows,
  buildPlayerWhy,
  clamp01,
} from "./valuationExplainabilityHelpers";
import { getOrBuildExplainabilityContext } from "./valuationExplainabilityContext";
import type {
  LeanPlayer,
  NormalizedValuationInput,
  ValuationResponse,
} from "../types/brain";

type ContextScope = {
  playerId?: string;
  position?: string;
};

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

  const cached = getOrBuildExplainabilityContext({
    response,
    input,
    allPlayers,
    effectiveScope,
  });

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
        row.indicator === "Fair Value" ? 0.7 : row.indicator === "Steal" ? 0.78 : 0.74;
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
    idxTop != null && Number.isFinite(idxTop) ? Math.round((idxTop - 1) * 100) : undefined;

  return {
    ...response,
    ...(pctAuctionTop != null ? { inflation_percent_vs_auction_open: pctAuctionTop } : {}),
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
