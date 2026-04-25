import { ENGINE_CONTRACT_VERSION } from "../lib/engineContract";
import { getValuationModelVersion } from "../lib/valuationModelVersion";
import { filterByScope } from "../lib/leagueScope";
import { computeReplacementSlotsV2 } from "./replacementSlotsV2";
import {
  fitsRosterSlot,
  playerTokensFromDrafted,
  playerTokensFromLean,
} from "../lib/fantasyRosterSlots";
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  InflationBoundedBy,
  InflationModel,
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

/** Minimum auction bid reserved per empty roster slot (surplus model). */
const MIN_AUCTION_BID = 1;
const RECOMMENDED_BID_LAMBDA_DEFAULT = 0.35;
const RECOMMENDED_BID_LAMBDA_TOP_TIER = 0.45;
const RECOMMENDED_BID_TOP_N = 24;
const RECOMMENDED_BID_NOTE =
  "recommended_bid blends model marginal value with baseline strength for auction guidance";
const TEAM_ADJUSTED_NOTE =
  "team_adjusted_value reflects team-specific need and budget relative to the league";
const DEFAULT_USER_TEAM_ID = "team_1";

const FLEX_SLOTS = new Set(["UTIL", "CI", "MI", "P"]);

/** Draftable pool size = ceil(remaining_slots × multiplier), capped by undrafted count. */
const DEFAULT_SURPLUS_DRAFTABLE_MULTIPLIER = 1.35;

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

function isStartingSlot(slot: string): boolean {
  return slot.toUpperCase() !== "BN";
}

function slotPriorityScore(slot: string): number {
  const u = slot.toUpperCase();
  if (u === "C") return 10;
  if (u === "SS") return 20;
  if (u === "2B") return 30;
  if (u === "3B") return 40;
  if (u === "1B") return 50;
  if (u === "OF") return 60;
  if (u === "SP") return 70;
  if (u === "RP") return 80;
  if (u === "UTIL") return 90;
  if (u === "CI") return 100;
  if (u === "MI") return 110;
  if (u === "P") return 120;
  return 200;
}

function buildOpenSlotsForUserTeam(
  rosterSlots: RosterSlot[],
  rosteredPlayersForSlots: DraftedPlayer[] | undefined,
  userTeamId: string
): Map<string, number> {
  const open = new Map<string, number>();
  for (const rs of rosterSlots) {
    const slot = rs.position.toUpperCase().trim();
    if (!slot || !isStartingSlot(slot)) continue;
    open.set(slot, (open.get(slot) ?? 0) + Math.max(0, Math.floor(rs.count ?? 0)));
  }
  const teamRows = (rosteredPlayersForSlots ?? []).filter(
    (p) => p.team_id === userTeamId
  );
  const sortedSlots = [...open.keys()].sort(
    (a, b) => slotPriorityScore(a) - slotPriorityScore(b)
  );
  for (const row of teamRows) {
    const tokens = playerTokensFromDrafted(row);
    for (const slot of sortedSlots) {
      const need = open.get(slot) ?? 0;
      if (need <= 0) continue;
      if (!fitsRosterSlot(slot, tokens)) continue;
      open.set(slot, need - 1);
      break;
    }
  }
  return open;
}

function positionalNeedMultiplier(
  p: LeanPlayer,
  openSlots: Map<string, number>
): number {
  const tokens = playerTokensFromLean(p);
  const slots = [...openSlots.keys()];
  const hasOpenPrimary = slots.some((slot) => {
    const u = slot.toUpperCase();
    return (
      !FLEX_SLOTS.has(u) &&
      (openSlots.get(slot) ?? 0) > 0 &&
      fitsRosterSlot(slot, tokens)
    );
  });
  if (hasOpenPrimary) return 1.25;

  const hasOpenFlex = slots.some((slot) => {
    const u = slot.toUpperCase();
    return FLEX_SLOTS.has(u) && (openSlots.get(slot) ?? 0) > 0 && fitsRosterSlot(u, tokens);
  });
  if (hasOpenFlex) return 1.1;

  const fitsAnyStarting = slots.some((slot) => fitsRosterSlot(slot, tokens));
  if (fitsAnyStarting) return 0.85;

  return 1.0;
}

function budgetPressureMultiplier(
  draftedPlayers: DraftedPlayer[],
  totalBudgetPerTeam: number,
  numTeams: number,
  budgetByTeamId: Record<string, number> | undefined,
  userTeamId: string,
  budgetRemaining: number
): number {
  let userRemaining: number;
  let leagueAvgRemaining: number;

  if (budgetByTeamId && Object.keys(budgetByTeamId).length > 0) {
    userRemaining = budgetByTeamId[userTeamId] ?? totalBudgetPerTeam;
    leagueAvgRemaining =
      Object.values(budgetByTeamId).reduce((s, v) => s + v, 0) /
      Math.max(1, Object.keys(budgetByTeamId).length);
  } else {
    let userSpent = 0;
    for (const dp of draftedPlayers) {
      if (dp.team_id !== userTeamId) continue;
      userSpent += dp.paid ?? 0;
    }
    userRemaining = Math.max(0, totalBudgetPerTeam - userSpent);
    leagueAvgRemaining = budgetRemaining / Math.max(1, numTeams);
  }

  if (userRemaining > 1.25 * leagueAvgRemaining) return 1.15;
  if (userRemaining < 0.75 * leagueAvgRemaining) return 0.85;
  return 1.0;
}

type SurplusPlan = {
  replacementValue: number;
  poolSurplusSum: number;
  surplusCash: number;
};

function tryBuildSurplusPlan(
  byValueFull: LeanPlayer[],
  undraftedCount: number,
  remainingSlots: number,
  budgetRemaining: number,
  options?: CalculateInflationOptions
): SurplusPlan | null {
  if (remainingSlots <= 0 || undraftedCount === 0) return null;
  const mult =
    options?.surplusDraftablePoolMultiplier ?? DEFAULT_SURPLUS_DRAFTABLE_MULTIPLIER;
  const k = Math.min(undraftedCount, Math.ceil(remainingSlots * mult));
  if (k < 1) return null;
  const draftable = byValueFull.slice(0, k);
  const replacementValue = draftable[draftable.length - 1]?.value ?? 0;
  let poolSurplusSum = 0;
  for (const p of draftable) {
    poolSurplusSum += Math.max(0, (p.value || 0) - replacementValue);
  }
  if (poolSurplusSum <= 0) return null;
  const surplusCash = Math.max(
    0,
    budgetRemaining - remainingSlots * MIN_AUCTION_BID
  );
  return { replacementValue, poolSurplusSum, surplusCash };
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
 * **`inflation_model`:**
 * - `global_v1` — `inflation_factor` ≈ remaining budget ÷ sum of baseline $ on the **full** undrafted pool;
 *   `adjusted_value` = `baseline_value × inflation_factor`.
 * - `surplus_slots_v1` — reserves `MIN_AUCTION_BID` per remaining empty roster slot, builds a
 *   top-by-baseline draftable slice sized from those slots, sets replacement at the slice floor,
 *   then `inflation_raw = surplus_cash / Σ max(0, baseline − replacement)` on that slice and
 *   `adjusted_value = MIN_AUCTION_BID + inflation_factor × max(0, baseline − replacement)` for
 *   every undrafted row. Falls back to `global_v1` math when the surplus plan is degenerate.
 * - `replacement_slots_v2` — slot/position-aware replacement levels + surplus allocation
 *   (preferred for Draftroom). Never falls back to `global_v1`; see response metadata.
 *
 * **`player_ids`:** does not change the inflation denominator; it only filters
 * which rows appear in `valuations[]` (same parameters applied to each).
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
  rosterSlots: RosterSlot[],
  leagueScope: LeagueScope = "Mixed",
  options?: CalculateInflationOptions
): ValuationResponse {
  const requestedModel: InflationModel =
    options?.inflationModel ?? "global_v1";

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

  const poolValueFull = undraftedFull.reduce((sum, p) => sum + (p.value || 0), 0);

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

  let inflationModelEffective: InflationModel = "global_v1";
  let poolValueRemaining: number;
  let rawInflationFactor: number;
  let replacementValue = 0;
  let v2Meta: Partial<ValuationResponse> = {};
  let v2Result: ReturnType<typeof computeReplacementSlotsV2> | null = null;

  if (requestedModel === "replacement_slots_v2") {
    const rostered = options?.rosteredPlayersForSlots ?? draftedPlayers;
    const baselineById = new Map<string, number>();
    for (const p of scoped) {
      baselineById.set(getPlayerId(p), p.value || 0);
    }
    v2Result = computeReplacementSlotsV2(
      undraftedFull,
      rostered,
      rosterSlots,
      numTeams,
      budgetRemaining,
      baselineById,
      {
        deterministic: options?.deterministic,
        seed: options?.seed,
      }
    );
    inflationModelEffective = "replacement_slots_v2";
    poolValueRemaining = v2Result.pool_value_remaining;
    rawInflationFactor = v2Result.inflation_factor_precap;
    v2Meta = {
      remaining_slots: v2Result.remaining_slots,
      min_bid: v2Result.min_bid,
      surplus_cash: v2Result.surplus_cash,
      total_surplus_mass: v2Result.total_surplus_mass,
      draftable_pool_size: v2Result.draftablePoolSize,
      replacement_values_by_slot_or_position:
        v2Result.replacement_values_by_slot_or_position,
      fallback_reason: v2Result.fallback_reason,
    };
  } else {
    const surplusPlan =
      requestedModel === "surplus_slots_v1"
        ? tryBuildSurplusPlan(
            byValueFull,
            undraftedFull.length,
            options?.remainingLeagueSlots ?? -1,
            budgetRemaining,
            options
          )
        : null;

    if (surplusPlan) {
      inflationModelEffective = "surplus_slots_v1";
      poolValueRemaining = surplusPlan.poolSurplusSum;
      rawInflationFactor =
        surplusPlan.poolSurplusSum > 0
          ? surplusPlan.surplusCash / surplusPlan.poolSurplusSum
          : 1;
      replacementValue = surplusPlan.replacementValue;
    } else {
      inflationModelEffective = "global_v1";
      poolValueRemaining = poolValueFull;
      rawInflationFactor =
        poolValueFull > 0 ? budgetRemaining / poolValueFull : 1;
    }
  }

  let clamped = clampInflation(
    rawInflationFactor,
    options?.inflationCap,
    options?.inflationFloor
  );
  if (
    inflationModelEffective === "replacement_slots_v2" &&
    v2Result?.skip_inflation_clamp
  ) {
    clamped = {
      inflation_raw: v2Result.inflation_raw,
      inflation_factor: v2Result.inflation_factor_precap,
      inflation_bounded_by: "none",
    };
  }
  const inflationFactor = clamped.inflation_factor;
  const inflationRaw = clamped.inflation_raw;
  const inflationBoundedBy = clamped.inflation_bounded_by;

  const valuations: ValuedPlayer[] = byValueRows.map((p) => {
    const pid = getPlayerId(p);
    const baselineValue = p.value || 0;
    let adjustedValue: number;
    if (inflationModelEffective === "replacement_slots_v2" && v2Result) {
      const sb = v2Result.playerIdToSurplusBasis.get(pid) ?? 0;
      if (v2Result.baselineOnly) {
        adjustedValue = parseFloat(baselineValue.toFixed(2));
      } else if (
        v2Result.fallback_reason === "no_surplus_mass" &&
        v2Result.surplus_cash > 0
      ) {
        adjustedValue = parseFloat(
          Math.max(MIN_AUCTION_BID, baselineValue).toFixed(2)
        );
      } else {
        adjustedValue = parseFloat(
          (MIN_AUCTION_BID + inflationFactor * sb).toFixed(2)
        );
      }
    } else if (inflationModelEffective === "surplus_slots_v1") {
      adjustedValue = parseFloat(
        (
          MIN_AUCTION_BID +
          inflationFactor * Math.max(0, baselineValue - replacementValue)
        ).toFixed(2)
      );
    } else {
      adjustedValue = parseFloat(
        (baselineValue * inflationFactor).toFixed(2)
      );
    }
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
      // inflation_adjustment: full delta from inflation pass (adjusted − baseline).
      inflation_adjustment: parseFloat((adjustedValue - baselineValue).toFixed(2)),
    };
  });

  // Presentation-only blend; valuation math (baseline/adjusted/inflation) stays unchanged.
  const topTierIds = new Set(
    byValueRows.slice(0, RECOMMENDED_BID_TOP_N).map((p) => getPlayerId(p))
  );
  for (const row of valuations) {
    const lambda = topTierIds.has(row.player_id)
      ? RECOMMENDED_BID_LAMBDA_TOP_TIER
      : RECOMMENDED_BID_LAMBDA_DEFAULT;
    const raw =
      row.adjusted_value + lambda * (row.baseline_value - row.adjusted_value);
    const lo = Math.min(row.adjusted_value, row.baseline_value);
    const hi = Math.max(row.adjusted_value, row.baseline_value);
    const clamped = Math.max(lo, Math.min(hi, raw));
    row.recommended_bid = parseFloat(clamped.toFixed(2));
  }

  const userTeamId = options?.userTeamId?.trim() || DEFAULT_USER_TEAM_ID;
  const openSlots = buildOpenSlotsForUserTeam(
    rosterSlots,
    options?.rosteredPlayersForSlots,
    userTeamId
  );
  const budgetMult = budgetPressureMultiplier(
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    options?.budgetByTeamId,
    userTeamId,
    budgetRemaining
  );
  const byRowPlayerId = new Map(byValueRows.map((p) => [getPlayerId(p), p]));
  for (const row of valuations) {
    const lp = byRowPlayerId.get(row.player_id);
    if (!lp) continue;
    const needMult = positionalNeedMultiplier(lp, openSlots);
    const rawTeamAdjusted = row.adjusted_value * needMult * budgetMult;
    const cap = Math.max(0, row.baseline_value * 1.5);
    const clamped = Math.max(0, Math.min(cap, rawTeamAdjusted));
    row.team_adjusted_value = parseFloat(clamped.toFixed(2));
  }

  const calculatedAt = options?.deterministic
    ? DETERMINISTIC_CALCULATED_AT
    : new Date().toISOString();

  return {
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    inflation_model: inflationModelEffective,
    inflation_factor: parseFloat(inflationFactor.toFixed(4)),
    inflation_raw: parseFloat(inflationRaw.toFixed(6)),
    inflation_bounded_by: inflationBoundedBy,
    total_budget_remaining: budgetRemaining,
    pool_value_remaining: parseFloat(poolValueRemaining.toFixed(2)),
    players_remaining: undraftedFull.length,
    valuations,
    recommended_bid_note: RECOMMENDED_BID_NOTE,
    user_team_id_used: userTeamId,
    team_adjusted_value_note: TEAM_ADJUSTED_NOTE,
    calculated_at: calculatedAt,
    valuation_model_version: getValuationModelVersion(),
    ...v2Meta,
  };
}
