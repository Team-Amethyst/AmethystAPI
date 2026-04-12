import { ENGINE_CONTRACT_VERSION } from "../lib/engineContract";
import { filterByScope } from "../lib/leagueScope";
import {
  CalculateInflationOptions,
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

const DETERMINISTIC_CALCULATED_AT = "1970-01-01T00:00:00.000Z";

/**
 * Returns the canonical ID used to match this player against drafted_players.
 * Prefers mlbId (string) since that's what Draftroom sends; falls back to _id.
 */
export function getPlayerId(player: LeanPlayer): string {
  return player.mlbId != null ? String(player.mlbId) : String(player._id);
}

/** Deterministic 32-bit mix for seeded tie-breaks (grading / CI). */
function hash32(seed: number, s: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i);
    h >>>= 0;
  }
  return h >>> 0;
}

function compareByValueDesc(
  a: LeanPlayer,
  b: LeanPlayer,
  options?: CalculateInflationOptions
): number {
  const diff = (b.value || 0) - (a.value || 0);
  if (diff !== 0) return diff;
  if (
    options?.deterministic &&
    options.seed != null &&
    Number.isFinite(options.seed)
  ) {
    return (
      hash32(options.seed, getPlayerId(a)) - hash32(options.seed, getPlayerId(b))
    );
  }
  return getPlayerId(a).localeCompare(getPlayerId(b));
}

function compareByAdpAsc(
  a: LeanPlayer,
  b: LeanPlayer,
  options?: CalculateInflationOptions
): number {
  const diff = (a.adp || 9999) - (b.adp || 9999);
  if (diff !== 0) return diff;
  if (
    options?.deterministic &&
    options.seed != null &&
    Number.isFinite(options.seed)
  ) {
    return (
      hash32(options.seed, getPlayerId(a)) - hash32(options.seed, getPlayerId(b))
    );
  }
  return getPlayerId(a).localeCompare(getPlayerId(b));
}

/**
 * Calculates auction inflation and returns adjusted player valuations.
 *
 * **Budget (contract):**
 * - If `options.budgetByTeamId` is non-empty: `total_budget_remaining` = **sum of map values**
 *   (per-team **remaining** dollars). **`paid` on `drafted_players` is ignored** for that request.
 * - Otherwise: `total_budget_remaining` = `total_budget * num_teams` − **sum(`drafted_players[].paid`)**
 *   (missing `paid` treated as 0). **`pre_draft_rosters`, `minors`, and `taxi` do not affect spend in v1.**
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
  leagueScope: LeagueScope = "Mixed",
  options?: CalculateInflationOptions
): ValuationResponse {
  const draftedIds = new Set(draftedPlayers.map((d) => d.player_id));

  const scoped = filterByScope(allPlayers, leagueScope);
  let undrafted = scoped.filter((p) => !draftedIds.has(getPlayerId(p)));

  if (options?.playerIdsFilter && options.playerIdsFilter.length > 0) {
    const allow = new Set(options.playerIdsFilter);
    undrafted = undrafted.filter((p) => allow.has(getPlayerId(p)));
  }

  const totalLeagueBudget = totalBudgetPerTeam * numTeams;
  let budgetRemaining: number;
  if (
    options?.budgetByTeamId &&
    Object.keys(options.budgetByTeamId).length > 0
  ) {
    budgetRemaining = Object.values(options.budgetByTeamId).reduce(
      (sum, v) => sum + v,
      0
    );
  } else {
    const budgetSpent = draftedPlayers.reduce(
      (sum, dp) => sum + (dp.paid ?? 0),
      0
    );
    budgetRemaining = Math.max(0, totalLeagueBudget - budgetSpent);
  }

  const poolValue = undrafted.reduce((sum, p) => sum + (p.value || 0), 0);

  const inflationFactor = poolValue > 0 ? budgetRemaining / poolValue : 1;

  const byValue = [...undrafted].sort((a, b) =>
    compareByValueDesc(a, b, options)
  );
  const byAdp = [...undrafted].sort((a, b) => compareByAdpAsc(a, b, options));

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
      if (aRank > vRank * STEAL_SLOPE) indicator = "Steal";
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

  const calculatedAt = options?.deterministic
    ? DETERMINISTIC_CALCULATED_AT
    : new Date().toISOString();

  return {
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    inflation_factor: parseFloat(inflationFactor.toFixed(4)),
    total_budget_remaining: budgetRemaining,
    pool_value_remaining: parseFloat(poolValue.toFixed(2)),
    players_remaining: undrafted.length,
    valuations,
    calculated_at: calculatedAt,
  };
}
