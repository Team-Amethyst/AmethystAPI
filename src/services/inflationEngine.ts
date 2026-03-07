import { filterByScope } from "../lib/leagueScope";
import {
  DraftedPlayer,
  LeanPlayer,
  LeagueScope,
  RosterSlot,
  ValuedPlayer,
  ValueIndicator,
  ValuationResponse,
} from "../types/brain";

/**
 * A player is a "Steal" if ADP rank is significantly later than value rank
 * (the market undervalues them) and a "Reach" if ADP rank is significantly
 * earlier than value rank (the market overvalues them).
 */
const STEAL_SLOPE = 1.25; // ADP rank ≥ 25% later than value rank
const REACH_SLOPE = 0.75; // ADP rank ≥ 25% earlier than value rank

function getPlayerId(player: LeanPlayer): string {
  return String(player._id);
}

/**
 * Calculates auction inflation and returns adjusted player valuations.
 *
 * Inflation Factor = Remaining League Budget / Remaining Player Pool Value
 *   > 1.0 → more money chasing remaining talent → prices inflate
 *   < 1.0 → surplus talent relative to budget → prices deflate
 *
 * Value Indicator:
 *   We rank every undrafted player both by projection value and by ADP.
 *   A rank mismatch between the two reveals market inefficiencies.
 */
export function calculateInflation(
  allPlayers: LeanPlayer[],
  draftedPlayers: DraftedPlayer[],
  totalBudgetPerTeam: number,
  numTeams: number,
  _rosterSlots: RosterSlot[], // reserved for future per-slot budget attribution
  leagueScope: LeagueScope = "Mixed"
): ValuationResponse {
  const draftedIds = new Set(draftedPlayers.map((d) => d.player_id));

  const scoped = filterByScope(allPlayers, leagueScope);
  const undrafted = scoped.filter((p) => !draftedIds.has(getPlayerId(p)));

  // ── Budget math ────────────────────────────────────────────────────────────
  const totalLeagueBudget = totalBudgetPerTeam * numTeams;
  const budgetSpent = draftedPlayers.reduce(
    (sum, dp) => sum + (dp.paid ?? 0),
    0
  );
  const budgetRemaining = Math.max(0, totalLeagueBudget - budgetSpent);

  // Sum of all undrafted players' baseline projection values
  const poolValue = undrafted.reduce((sum, p) => sum + (p.value || 0), 0);

  // Avoid division by zero; default to neutral inflation when pool is empty
  const inflationFactor = poolValue > 0 ? budgetRemaining / poolValue : 1;

  // ── Rank maps for Steal / Reach detection ─────────────────────────────────
  const byValue = [...undrafted].sort((a, b) => (b.value || 0) - (a.value || 0));
  const byAdp = [...undrafted].sort(
    (a, b) => (a.adp || 9999) - (b.adp || 9999)
  );

  const valueRank = new Map(byValue.map((p, i) => [getPlayerId(p), i + 1]));
  const adpRank = new Map(byAdp.map((p, i) => [getPlayerId(p), i + 1]));
  const n = undrafted.length;

  const valuations: ValuedPlayer[] = byValue.map((p) => {
    const pid = getPlayerId(p);
    const baselineValue = p.value || 0;
    const adjustedValue = parseFloat((baselineValue * inflationFactor).toFixed(2));

    let indicator: ValueIndicator = "Fair Value";
    if (n > 0) {
      const vRank = valueRank.get(pid) ?? 0;
      const aRank = adpRank.get(pid) ?? 0;
      // ADP says "grab them late" but value says "they're top-tier" → Steal
      if (aRank > vRank * STEAL_SLOPE) indicator = "Steal";
      // ADP says "grab them early" but value doesn't support it → Reach
      else if (aRank < vRank * REACH_SLOPE) indicator = "Reach";
    }

    return {
      player_id: pid,
      name: p.name,
      position: p.position,
      team: p.team,
      adp: p.adp || 0,
      tier: p.tier || 0,
      baseline_value: baselineValue,
      adjusted_value: adjustedValue,
      indicator,
      inflation_factor: parseFloat(inflationFactor.toFixed(4)),
    };
  });

  return {
    inflation_factor: parseFloat(inflationFactor.toFixed(4)),
    total_budget_remaining: budgetRemaining,
    pool_value_remaining: parseFloat(poolValue.toFixed(2)),
    players_remaining: undrafted.length,
    valuations,
    calculated_at: new Date().toISOString(),
  };
}
