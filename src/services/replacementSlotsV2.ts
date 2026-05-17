import type { DraftedPlayer, LeanPlayer, RosterSlot } from "../types/brain";
import { getPlayerId } from "../lib/playerId";
import {
  buildLeagueSlotDemand,
  cloneDemandMap,
  bestMarginalSlotPick,
  assignCandidateToSlot,
  marginalScoreForSlot,
  slotCurrentMin,
  greedyAssignLeagueSlotsMutable,
  maxSurplusOverSlots,
  playerTokensFromLean,
  type PositionOverrideMap,
  replacementLevelsFromSlotValuesPercentile,
  replacementLevelsFromSlotValues,
  sumDemand,
} from "../lib/fantasyRosterSlots";
import {
  DEFAULT_HYBRID_SURPLUS_CALIBRATION,
  type HybridSurplusCalibration,
  REPLACEMENT_SLOTS_V2_MIN_BID,
  SLOT_REPLACEMENT_DEFAULT_PERCENTILE,
  SLOT_REPLACEMENT_PERCENTILE,
} from "./replacementSlotsV2Config";
import type { ReplacementSlotsV2Result } from "./replacementSlotsV2Types";
import {
  buildRosteredCandidates,
  applyHybridDraftableSurplusBasis,
  buildSurplusBasisMap,
  buildUndraftedCandidates,
  buildUndraftedPoolReplacementFloors,
  effectiveMarginalReplacement,
  finalizeReplacementValuesForSurplus,
  surplusForDraftableAssignment,
  type MarginalAssignmentSurplus,
} from "./replacementSlotsV2Helpers";

export type { ReplacementSlotsV2Result } from "./replacementSlotsV2Types";

/**
 * Position/slot-aware surplus inflation (Draftroom preferred). No global_v1 fallback.
 */
export function computeReplacementSlotsV2(
  undrafted: LeanPlayer[],
  rostered: DraftedPlayer[],
  rosterSlots: RosterSlot[],
  numTeams: number,
  budgetRemaining: number,
  baselineById: Map<string, number>,
  options?: {
    deterministic?: boolean;
    seed?: number;
    inflationCap?: number;
    inflationFloor?: number;
    positionOverrides?: PositionOverrideMap;
    hybridSurplusCalibration?: HybridSurplusCalibration;
    categoryProjectionById?: Map<string, number>;
  }
): ReplacementSlotsV2Result {
  const deterministic = Boolean(options?.deterministic);
  const seed = options?.seed ?? 0;
  const positionOverrides = options?.positionOverrides;

  const rosterSlotKeys = new Set<string>();
  const initialDemand = buildLeagueSlotDemand(rosterSlots, numTeams);
  for (const k of initialDemand.keys()) rosterSlotKeys.add(k);

  const slotValues = new Map<string, number[]>();
  const demand = cloneDemandMap(initialDemand);

  const rosteredCandidates = buildRosteredCandidates(
    rostered,
    baselineById,
    deterministic,
    seed,
    positionOverrides
  );

  greedyAssignLeagueSlotsMutable(
    rosteredCandidates,
    demand,
    slotValues,
    rosterSlotKeys,
    { deterministic, seed }
  );

  const remaining_slots = sumDemand(demand);

  if (undrafted.length === 0) {
    return {
      inflation_raw: 0,
      inflation_factor_precap: 0,
      pool_value_remaining: 0,
      playerIdToSurplusBasis: new Map(),
      draftablePoolSize: 0,
      draftablePlayerIds: [],
      remaining_slots,
      min_bid: REPLACEMENT_SLOTS_V2_MIN_BID,
      surplus_cash: Math.max(
        0,
        budgetRemaining - remaining_slots * REPLACEMENT_SLOTS_V2_MIN_BID
      ),
      total_surplus_mass: 0,
      replacement_values_by_slot_or_position: replacementLevelsFromSlotValues(
        slotValues,
        rosterSlotKeys
      ),
      fallback_reason: "no_undrafted_players",
      baselineOnly: false,
      skip_inflation_clamp: true,
    };
  }

  if (remaining_slots <= 0) {
    const repl = replacementLevelsFromSlotValues(slotValues, rosterSlotKeys);
    const m = new Map<string, number>();
    for (const p of undrafted) {
      m.set(
        getPlayerId(p),
        maxSurplusOverSlots(
          p.value || 0,
          playerTokensFromLean(p, positionOverrides),
          repl,
          rosterSlotKeys
        )
      );
    }
    return {
      inflation_raw: 1,
      inflation_factor_precap: 1,
      pool_value_remaining: 0,
      playerIdToSurplusBasis: m,
      draftablePoolSize: 0,
      draftablePlayerIds: [],
      remaining_slots: 0,
      min_bid: REPLACEMENT_SLOTS_V2_MIN_BID,
      surplus_cash: Math.max(0, budgetRemaining),
      total_surplus_mass: 0,
      replacement_values_by_slot_or_position: repl,
      fallback_reason: "no_remaining_slots",
      baselineOnly: true,
      skip_inflation_clamp: true,
    };
  }

  const undraftedCandidates = buildUndraftedCandidates(
    undrafted,
    deterministic,
    seed,
    positionOverrides
  );
  const undraftedCandidateById = new Map(
    undraftedCandidates.map((c) => [c.player_id, c] as const)
  );
  const replAfterRostered = replacementLevelsFromSlotValues(
    slotValues,
    rosterSlotKeys
  );
  const replPoolFloor = buildUndraftedPoolReplacementFloors(
    undraftedCandidates,
    rosterSlotKeys,
    SLOT_REPLACEMENT_PERCENTILE,
    SLOT_REPLACEMENT_DEFAULT_PERCENTILE
  );

  const undraftedAssignedIds = new Set<string>();
  const undraftedSlotValues = new Map<string, number[]>();
  const marginalByPlayerId = new Map<string, MarginalAssignmentSurplus>();
  const playerIdToAssignedSlot = new Map<string, string>();
  const playerIdToMarginalReplacement = new Map<string, number>();
  const remainingUndraftedIds = new Set(
    undraftedCandidates.map((c) => c.player_id)
  );

  const onAssignPlayer = (
    playerId: string,
    slotKey: string,
    baseline: number,
    marginalReplacement: number
  ) => {
    const arr = undraftedSlotValues.get(slotKey) ?? [];
    arr.push(baseline);
    undraftedSlotValues.set(slotKey, arr);
    const c = undraftedCandidateById.get(playerId);
    const tokens = c?.tokens ?? [];
    const effectiveMarginal = effectiveMarginalReplacement(
      slotKey,
      marginalReplacement,
      replAfterRostered,
      replPoolFloor
    );
    const surplus = surplusForDraftableAssignment({
      baseline,
      tokens,
      slotKey,
      marginalReplacement,
      replAfterRostered,
      replPoolFloor,
      rosterSlotKeys,
    });
    marginalByPlayerId.set(playerId, {
      slot: slotKey,
      marginalReplacement: effectiveMarginal,
      surplus,
    });
    playerIdToAssignedSlot.set(playerId, slotKey);
    playerIdToMarginalReplacement.set(playerId, effectiveMarginal);
  };

  const assignOneToSlot = (
    bestCandidate: (typeof undraftedCandidates)[number],
    slotKey: string
  ) => {
    const before = sumDemand(demand);
    const ok = assignCandidateToSlot(
      bestCandidate,
      slotKey,
      demand,
      slotValues,
      {
        rosteredReplFloor: replAfterRostered,
        replPoolFloor,
        onAssign: onAssignPlayer,
      }
    );
    if (!ok) return;
    const after = sumDemand(demand);
    remainingUndraftedIds.delete(bestCandidate.player_id);
    if (after < before) undraftedAssignedIds.add(bestCandidate.player_id);
  };

  const activeSlotOrder = [...rosterSlotKeys].filter(
    (k) => k.toUpperCase() !== "BN"
  );
  const baselineFirstSlots = new Set(
    ["C", "1B", "2B", "3B", "SS"].filter((s) => rosterSlotKeys.has(s))
  );

  /** One pass per active slot per round so OF/SP both advance (not baseline-sorted SP monopolization). */
  while (sumDemand(demand) > 0 && remainingUndraftedIds.size > 0) {
    let progressed = false;
    for (const slotKey of activeSlotOrder) {
      if ((demand.get(slotKey) ?? 0) <= 0) continue;

      let bestCandidate: (typeof undraftedCandidates)[number] | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestBaseline = Number.NEGATIVE_INFINITY;
      let bestTieId = "";
      const preferBaseline =
        baselineFirstSlots.has(slotKey) &&
        slotCurrentMin(slotValues, slotKey) <= 1e-9;

      for (const c of undraftedCandidates) {
        if (!remainingUndraftedIds.has(c.player_id)) continue;
        const pick = marginalScoreForSlot(
          c,
          slotKey,
          demand,
          slotValues,
          replAfterRostered,
          replPoolFloor
        );
        if (pick == null || pick.score <= 0) continue;
        if (preferBaseline) {
          if (
            c.baseline > bestBaseline + 1e-9 ||
            (Math.abs(c.baseline - bestBaseline) < 1e-9 &&
              c.player_id.localeCompare(bestTieId) < 0)
          ) {
            bestCandidate = c;
            bestBaseline = c.baseline;
            bestScore = pick.score;
            bestTieId = c.player_id;
          }
          continue;
        }
        if (
          pick.score > bestScore + 1e-9 ||
          (Math.abs(pick.score - bestScore) < 1e-9 &&
            c.player_id.localeCompare(bestTieId) < 0)
        ) {
          bestCandidate = c;
          bestScore = pick.score;
          bestBaseline = c.baseline;
          bestTieId = c.player_id;
        }
      }

      if (bestCandidate == null) continue;
      assignOneToSlot(bestCandidate, slotKey);
      progressed = true;
    }
    if (!progressed) break;
  }

  while (sumDemand(demand) > 0 && remainingUndraftedIds.size > 0) {
    let bestCandidate: (typeof undraftedCandidates)[number] | null = null;
    let bestPick: ReturnType<typeof bestMarginalSlotPick> = null;
    let bestTieId = "";

    for (const c of undraftedCandidates) {
      if (!remainingUndraftedIds.has(c.player_id)) continue;
      const pick = bestMarginalSlotPick(
        c,
        demand,
        slotValues,
        rosterSlotKeys,
        replAfterRostered,
        replPoolFloor,
        { deterministic, seed }
      );
      if (pick == null) continue;
      if (
        bestPick == null ||
        pick.score > bestPick.score + 1e-9 ||
        (Math.abs(pick.score - bestPick.score) < 1e-9 &&
          c.player_id.localeCompare(bestTieId) < 0)
      ) {
        bestCandidate = c;
        bestPick = pick;
        bestTieId = c.player_id;
      }
    }
    if (bestCandidate == null || bestPick == null) break;
    assignOneToSlot(bestCandidate, bestPick.slot);
  }

  const replacement_values_by_slot_or_position =
    finalizeReplacementValuesForSurplus(
      replacementLevelsFromSlotValuesPercentile(
        undraftedSlotValues,
        rosterSlotKeys,
        SLOT_REPLACEMENT_PERCENTILE,
        SLOT_REPLACEMENT_DEFAULT_PERCENTILE
      ),
      rosterSlotKeys
    );

  const surplus_cash = Math.max(
    0,
    budgetRemaining - remaining_slots * REPLACEMENT_SLOTS_V2_MIN_BID
  );

  const slotOnlySurplusBasis = buildSurplusBasisMap(
    undrafted,
    replacement_values_by_slot_or_position,
    rosterSlotKeys,
    positionOverrides,
    marginalByPlayerId,
    undraftedAssignedIds,
    replPoolFloor
  );

  let slotOnlyMass = 0;
  for (const id of undraftedAssignedIds) {
    slotOnlyMass += slotOnlySurplusBasis.get(id) ?? 0;
  }

  const draftableBaselineById = new Map<string, number>();
  const draftableTokensById = new Map<string, readonly string[]>();
  for (const c of undraftedCandidates) {
    draftableBaselineById.set(c.player_id, c.baseline);
    draftableTokensById.set(c.player_id, c.tokens);
  }
  const undraftedBaselinesForFloor: number[] = [];
  for (const p of undrafted) {
    const b = baselineById.get(getPlayerId(p)) ?? 0;
    if (b > 0) undraftedBaselinesForFloor.push(b);
  }

  const hybridApply =
    slotOnlyMass > 0
      ? applyHybridDraftableSurplusBasis({
          surplusBasisById: slotOnlySurplusBasis,
          assignedIds: undraftedAssignedIds,
          baselineById: draftableBaselineById,
          strengthFloorBaselines: undraftedBaselinesForFloor,
          playerTokensById: draftableTokensById,
          assignedSlotById: playerIdToAssignedSlot,
          categoryProjectionById: options?.categoryProjectionById,
          targetTotalMass: slotOnlyMass,
          calibration: options?.hybridSurplusCalibration,
        })
      : null;
  let playerIdToSurplusBasis = new Map(
    hybridApply?.surplusBasisById ?? slotOnlySurplusBasis
  );
  const playerIdToHybridLift = hybridApply?.hybridLiftByPlayerId;

  let total_surplus_mass = 0;
  for (const id of undraftedAssignedIds) {
    total_surplus_mass += playerIdToSurplusBasis.get(id) ?? 0;
  }

  const massGrowthCap =
    options?.hybridSurplusCalibration?.massGrowthCap ??
    DEFAULT_HYBRID_SURPLUS_CALIBRATION.massGrowthCap ??
    1.045;
  const massCap = slotOnlyMass * massGrowthCap;
  if (slotOnlyMass > 0 && total_surplus_mass > massCap + 1e-6) {
    const scale = massCap / total_surplus_mass;
    for (const id of undraftedAssignedIds) {
      const sb = playerIdToSurplusBasis.get(id) ?? 0;
      playerIdToSurplusBasis.set(id, sb * scale);
      if (playerIdToHybridLift?.has(id)) {
        const slotOnly = slotOnlySurplusBasis.get(id) ?? 0;
        playerIdToHybridLift.set(
          id,
          (playerIdToSurplusBasis.get(id) ?? 0) - slotOnly
        );
      }
    }
    total_surplus_mass = massCap;
  }

  const draftablePoolSize = undraftedAssignedIds.size;

  let inflation_raw: number;
  let inflation_factor_precap: number;
  let fallback_reason: string | null = null;
  let skip_inflation_clamp = false;

  if (surplus_cash <= 0) {
    inflation_raw = 0;
    inflation_factor_precap = 0;
    fallback_reason = "no_surplus_cash";
    skip_inflation_clamp = true;
  } else if (total_surplus_mass <= 0) {
    inflation_raw = 0;
    inflation_factor_precap = 0;
    fallback_reason = "no_surplus_mass";
    skip_inflation_clamp = true;
  } else {
    inflation_raw = surplus_cash / total_surplus_mass;
    inflation_factor_precap = inflation_raw;
  }

  const draftablePlayerIds = Array.from(undraftedAssignedIds);

  const pool_value_remaining = total_surplus_mass;

  return {
    inflation_raw,
    inflation_factor_precap,
    pool_value_remaining,
    playerIdToSurplusBasis,
    playerIdToSlotOnlySurplusBasis: slotOnlySurplusBasis,
    playerIdToHybridLift,
    playerIdToAssignedSlot,
    playerIdToMarginalReplacement,
    draftablePoolSize,
    draftablePlayerIds,
    remaining_slots,
    min_bid: REPLACEMENT_SLOTS_V2_MIN_BID,
    surplus_cash,
    total_surplus_mass,
    replacement_values_by_slot_or_position,
    fallback_reason,
    baselineOnly: false,
    skip_inflation_clamp,
  };
}
