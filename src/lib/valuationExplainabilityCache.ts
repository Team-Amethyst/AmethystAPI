import crypto from "crypto";
import type { NormalizedValuationInput, ValuationResponse } from "../types/brain";

export type ExplainabilityScope = {
  playerId?: string;
  position?: string;
};

export type CachedExplainabilityContext = NonNullable<
  ValuationResponse["context_v2"]
> & {
  market_notes: string[];
};

export function explainabilityCacheKey(
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

export function sortPositionAlerts<
  T extends { severity: string; urgency_score: number; position: string }
>(alerts: T[]): T[] {
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

export function upsertCachedContext(
  cache: Map<string, CachedExplainabilityContext>,
  key: string,
  value: CachedExplainabilityContext
): CachedExplainabilityContext {
  cache.set(key, value);
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return value;
}
