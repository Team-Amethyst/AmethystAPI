import { ENGINE_CONTRACT_VERSION } from "../lib/engineContract";
import { getValuationModelVersion } from "../lib/valuationModelVersion";
import { isSymmetricOpenLeagueContext } from "../lib/symmetricLeagueOpen";
import { filterByScope } from "../lib/leagueScope";
import {
  baseLambdaClearingPrice,
  computeRecommendedBid,
  smoothRecommendedBids,
} from "./recommendedBid";
import {
  bestReplacementForPlayer,
  budgetPressureMultiplier,
  buildOpenSlotsForUserTeam,
  computeTeamAdjustedValue,
  dollarsPerSlotPeerRatio,
  leagueSlotCapacity,
  teamAdjustedMultipliers,
  userBudgetRemaining,
  userTeamStartingSlots,
} from "./teamAdjustedValue";
import {
  clampInflation,
  computeBudgetRemaining,
  computeInflationIndexVsOpeningAuction,
  selectInflationModel,
} from "./inflationModel";
import {
  buildLeagueSlotDemand,
  playerTokensFromLean,
} from "../lib/fantasyRosterSlots";
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  DraftPhaseIndicator,
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
const RECOMMENDED_BID_NOTE =
  "recommended_bid is a phase-aware model clearing target (star floors, pitcher dampening, isotonic smoothing)—a bidding guide, not a prediction of the winning hammer price; room behavior can diverge materially.";
const TEAM_ADJUSTED_NOTE =
  "team_adjusted_value scales adjusted_value by roster need, dollars per open slot vs league peers, remaining-slot scarcity, and replacement drop-off for eligible slots; when the league snapshot is symmetric (no auction picks, no keeper/minors/taxi off-board ids, equal per-team budgets in budget_by_team_id when provided, equal rostered counts per team), it equals adjusted_value";
const DEFAULT_USER_TEAM_ID = "team_1";

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

function resolveDraftPhase(params: {
  rosterSlots: RosterSlot[];
  numTeams: number;
  remainingSlotsLeague: number;
  draftedCount: number;
}): DraftPhaseIndicator {
  const cap = leagueSlotCapacity(params.rosterSlots, params.numTeams);
  let fill = 0;
  if (cap > 0 && Number.isFinite(params.remainingSlotsLeague)) {
    fill = (cap - params.remainingSlotsLeague) / cap;
  } else if (cap > 0) {
    fill = Math.min(1, params.draftedCount / cap);
  }
  fill = Math.max(0, Math.min(1, fill));
  if (fill < 0.33) return "early";
  if (fill < 0.67) return "mid";
  return "late";
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

  const budgetRemaining = computeBudgetRemaining({
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId: options?.budgetByTeamId,
    additionalSpent: options?.additionalSpent,
  });

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

  const modelSelection = selectInflationModel({
    requestedModel,
    scoped,
    undraftedFull,
    byValueFull,
    draftedPlayers,
    rosterSlots,
    numTeams,
    budgetRemaining,
    options,
    poolValueFull,
    getPlayerId,
    minAuctionBid: MIN_AUCTION_BID,
    defaultSurplusDraftablePoolMultiplier: DEFAULT_SURPLUS_DRAFTABLE_MULTIPLIER,
  });
  const inflationModelEffective = modelSelection.inflationModelEffective;
  const poolValueRemaining = modelSelection.poolValueRemaining;
  const rawInflationFactor = modelSelection.rawInflationFactor;
  const replacementValue = modelSelection.replacementValue;
  const v2Meta = modelSelection.v2Meta;
  const v2Result = modelSelection.v2Result;

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

  const inflationIndexVsOpeningAuction = computeInflationIndexVsOpeningAuction({
    inflationModelEffective,
    v2Result,
    options,
    draftedPlayers,
    scoped,
    rosterSlots,
    numTeams,
    budgetRemaining,
    inflationFactor,
    getPlayerId,
  });

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

  const leagueCap = leagueSlotCapacity(rosterSlots, numTeams);
  const remainingSlotsLeague =
    v2Meta.remaining_slots ?? Math.max(0, leagueCap - draftedPlayers.length);
  const draftPhase = resolveDraftPhase({
    rosterSlots,
    numTeams,
    remainingSlotsLeague,
    draftedCount: draftedPlayers.length,
  });

  const baselineOrderForDepth = [...byValueRows].sort(
    (a, b) => (b.value || 0) - (a.value || 0)
  );
  const depthFracById = new Map<string, number>();
  const depthN = baselineOrderForDepth.length;
  baselineOrderForDepth.forEach((p, i) => {
    depthFracById.set(getPlayerId(p), depthN > 1 ? i / (depthN - 1) : 0);
  });

  const rosterDemandMap = buildLeagueSlotDemand(rosterSlots, numTeams);
  const rosterSlotKeysForFit = new Set(rosterDemandMap.keys());
  const replForTeam: Record<string, number> =
    inflationModelEffective === "replacement_slots_v2" && v2Result
      ? v2Result.replacement_values_by_slot_or_position
      : {};
  const byRowPlayerId = new Map(byValueRows.map((p) => [getPlayerId(p), p]));

  for (const row of valuations) {
    const depthFrac = depthFracById.get(row.player_id) ?? 0.5;
    const clearing = computeRecommendedBid({
      row,
      draftPhase,
      depthFrac,
      inflationIndexVsOpeningAuction,
      minAuctionBid: MIN_AUCTION_BID,
    });
    row.recommended_bid = parseFloat(clearing.toFixed(2));
    if (options?.debugSignals) {
      const lp = byRowPlayerId.get(row.player_id);
      const tokens = lp ? playerTokensFromLean(lp) : [];
      const replBest = bestReplacementForPlayer(
        tokens,
        replForTeam,
        rosterSlotKeysForFit
      );
      const sb =
        inflationModelEffective === "replacement_slots_v2" && v2Result
          ? v2Result.playerIdToSurplusBasis.get(row.player_id) ?? 0
          : undefined;
      row.debug_v2 = {
        ...(row.debug_v2 ?? {}),
        lambda_used: Number(baseLambdaClearingPrice(draftPhase, depthFrac).toFixed(4)),
        surplus_basis:
          sb != null && Number.isFinite(sb) ? Number(sb.toFixed(4)) : undefined,
        replacement_key_used: replBest?.key ?? null,
        replacement_value_used:
          replBest?.value != null ? Number(replBest.value.toFixed(4)) : null,
      };
    }
  }

  smoothRecommendedBids(valuations, MIN_AUCTION_BID);

  const symmetricOpenLeague = isSymmetricOpenLeagueContext({
    numTeams,
    draftedPlayers,
    additionalDraftedIds: options?.additionalDraftedIds ?? [],
    budgetByTeamId: options?.budgetByTeamId,
    rosteredPlayersForSlots: options?.rosteredPlayersForSlots,
  });

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
  const userRemaining = userBudgetRemaining(
    draftedPlayers,
    totalBudgetPerTeam,
    options?.budgetByTeamId,
    userTeamId
  );
  const openSeatTotal = [...openSlots.values()].reduce((s, v) => s + v, 0);
  const userCap = userTeamStartingSlots(rosterSlots);
  const slotFillRatio =
    userCap > 0 ? Math.max(0, Math.min(1, openSeatTotal / userCap)) : 1;
  const slotScarcityMult = 1 + 0.22 * (1 - slotFillRatio);
  const dpsRatio = dollarsPerSlotPeerRatio({
    userRemaining,
    openSeatTotal,
    budgetRemainingLeague: budgetRemaining,
    numTeams,
    remainingSlotsLeague: Math.max(1, remainingSlotsLeague),
  });
  let dpsMult = 1;
  if (dpsRatio > 1.18) {
    dpsMult += 0.14 * Math.min(2.2, dpsRatio - 1.18);
  } else if (dpsRatio < 0.82) {
    dpsMult -= 0.11 * Math.min(1.2, 0.82 - dpsRatio);
  }

  for (const row of valuations) {
    const lp = byRowPlayerId.get(row.player_id);
    if (!lp) continue;
    if (symmetricOpenLeague) {
      row.team_adjusted_value = parseFloat(row.adjusted_value.toFixed(2));
      if (options?.debugSignals) {
        row.debug_v2 = {
          ...(row.debug_v2 ?? {}),
          team_multipliers: {
            symmetric_open_collapsed: 1,
          },
        };
      }
      continue;
    }
    const multipliers = teamAdjustedMultipliers({
      row,
      lp,
      openSlots,
      budgetMult,
      dpsMult,
      slotScarcityMult,
      replForTeam,
      rosterSlotKeysForFit,
    });
    row.team_adjusted_value = computeTeamAdjustedValue({
      row,
      multipliers,
    });
    if (options?.debugSignals) {
      row.debug_v2 = {
        ...(row.debug_v2 ?? {}),
        team_multipliers: {
          need: Number(multipliers.need.toFixed(4)),
          budget: Number(multipliers.budget.toFixed(4)),
          dollars_per_slot: Number(multipliers.dollars_per_slot.toFixed(4)),
          slot_scarcity: Number(multipliers.slot_scarcity.toFixed(4)),
          replacement_dropoff: Number(multipliers.replacement_dropoff.toFixed(4)),
        },
      };
    }
  }

  for (const row of valuations) {
    const rb = row.recommended_bid ?? MIN_AUCTION_BID;
    const ta = row.team_adjusted_value ?? row.adjusted_value;
    row.edge = parseFloat((ta - rb).toFixed(2));
  }

  const slotMeta: Partial<ValuationResponse> = {
    ...v2Meta,
    ...(v2Meta.remaining_slots == null
      ? { remaining_slots: Math.max(0, leagueCap - draftedPlayers.length) }
      : {}),
  };

  const calculatedAt = options?.deterministic
    ? DETERMINISTIC_CALCULATED_AT
    : new Date().toISOString();

  return {
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    inflation_model: inflationModelEffective,
    inflation_factor: parseFloat(inflationFactor.toFixed(4)),
    ...(inflationIndexVsOpeningAuction != null
      ? { inflation_index_vs_opening_auction: inflationIndexVsOpeningAuction }
      : {}),
    inflation_raw: parseFloat(inflationRaw.toFixed(6)),
    inflation_bounded_by: inflationBoundedBy,
    total_budget_remaining: budgetRemaining,
    pool_value_remaining: parseFloat(poolValueRemaining.toFixed(2)),
    players_remaining: undraftedFull.length,
    valuations,
    recommended_bid_note: RECOMMENDED_BID_NOTE,
    user_team_id_used: userTeamId,
    team_adjusted_value_note: TEAM_ADJUSTED_NOTE,
    phase_indicator: draftPhase,
    calculated_at: calculatedAt,
    valuation_model_version: getValuationModelVersion(),
    ...slotMeta,
  };
}
