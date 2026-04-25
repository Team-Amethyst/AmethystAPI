import { ENGINE_CONTRACT_VERSION } from "../lib/engineContract";
import { getValuationModelVersion } from "../lib/valuationModelVersion";
import { filterByScope } from "../lib/leagueScope";
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  InflationBoundedBy,
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

function clampInflation(
  raw: number,
  cap: number | undefined,
  floor: number | undefined
): {
  inflation_raw: number;
  inflation_factor: number;
  inflation_bounded_by: InflationBoundedBy;
} {
  const capV =
    cap != null && Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
  const floorV =
    floor != null && Number.isFinite(floor) && floor > 0 ? floor : 0.25;
  const capped = Math.min(capV, raw);
  const applied = Math.max(floorV, capped);
  const eps = 1e-5;
  let inflation_bounded_by: InflationBoundedBy = "none";
  if (applied > raw + eps) inflation_bounded_by = "floor";
  else if (applied + eps < raw) inflation_bounded_by = "cap";
  return { inflation_raw: raw, inflation_factor: applied, inflation_bounded_by };
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
 * Inflation Factor = Remaining League Budget / **full** undrafted pool list value
 *   > 1.0 → more money chasing remaining talent → prices inflate
 *   < 1.0 → surplus talent relative to budget → prices deflate
 *
 * **`player_ids`:** does not change the inflation denominator; it only filters
 * which rows appear in `valuations[]` (same factor applied to each).
 *
 * Value Indicator:
 *   Ranks use the **full** undrafted pool so Steal/Reach stay meaningful when
 *   `valuations[]` is a subset.
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
  for (const pid of options?.additionalDraftedIds ?? []) {
    draftedIds.add(pid);
  }

  const scoped = filterByScope(allPlayers, leagueScope);
  const undraftedFull = scoped.filter((p) => !draftedIds.has(getPlayerId(p)));

  let undraftedForRows = undraftedFull;
  if (options?.playerIdsFilter && options.playerIdsFilter.length > 0) {
    const allow = new Set(options.playerIdsFilter);
    undraftedForRows = undraftedFull.filter((p) => allow.has(getPlayerId(p)));
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
    budgetRemaining = Math.max(
      0,
      totalLeagueBudget - budgetSpent - (options?.additionalSpent ?? 0)
    );
  }

  const poolValue = undraftedFull.reduce((sum, p) => sum + (p.value || 0), 0);

  const rawInflationFactor = poolValue > 0 ? budgetRemaining / poolValue : 1;
  const clamped = clampInflation(
    rawInflationFactor,
    options?.inflationCap,
    options?.inflationFloor
  );
  const inflationFactor = clamped.inflation_factor;
  const inflationRaw = clamped.inflation_raw;
  const inflationBoundedBy = clamped.inflation_bounded_by;

  const byValueFull = [...undraftedFull].sort((a, b) =>
    compareByValueDesc(a, b, options)
  );
  const byAdpFull = [...undraftedFull].sort((a, b) =>
    compareByAdpAsc(a, b, options)
  );
  const valueRank = new Map(
    byValueFull.map((p, i) => [getPlayerId(p), i + 1])
  );
  const adpRank = new Map(byAdpFull.map((p, i) => [getPlayerId(p), i + 1]));
  const n = undraftedFull.length;

  const byValueRows = [...undraftedForRows].sort((a, b) =>
    compareByValueDesc(a, b, options)
  );

  const valuations: ValuedPlayer[] = byValueRows.map((p) => {
    const pid = getPlayerId(p);
    const baselineValue = p.value || 0;
    const adjustedValue = parseFloat((baselineValue * inflationFactor).toFixed(2));
    const meta = (
      p.projection as
        | {
            __valuation_meta__?: {
              scoring_format?: "5x5" | "6x6" | "points";
              projection_component?: number;
              scarcity_component?: number;
            };
          }
        | undefined
    )?.__valuation_meta__;

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
      baseline_components: {
        scoring_format: meta?.scoring_format ?? "default",
        projection_component: meta?.projection_component ?? 0,
        scarcity_component: meta?.scarcity_component ?? 0,
      },
      // scarcity_adjustment: always 0 — roster/scarcity is in baseline_value (baseline_components).
      scarcity_adjustment: 0,
      // inflation_adjustment: full delta from league-wide factor (adjusted − baseline).
      inflation_adjustment: parseFloat((adjustedValue - baselineValue).toFixed(2)),
    };
  });

  const calculatedAt = options?.deterministic
    ? DETERMINISTIC_CALCULATED_AT
    : new Date().toISOString();

  return {
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    inflation_factor: parseFloat(inflationFactor.toFixed(4)),
    inflation_raw: parseFloat(inflationRaw.toFixed(6)),
    inflation_bounded_by: inflationBoundedBy,
    total_budget_remaining: budgetRemaining,
    pool_value_remaining: parseFloat(poolValue.toFixed(2)),
    players_remaining: undraftedFull.length,
    valuations,
    calculated_at: calculatedAt,
    valuation_model_version: getValuationModelVersion(),
  };
}
