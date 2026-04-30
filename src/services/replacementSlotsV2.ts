import type { DraftedPlayer, LeanPlayer, RosterSlot } from "../types/brain";
import { getPlayerId } from "../lib/playerId";
import {
  buildLeagueSlotDemand,
  cloneDemandMap,
  greedyAssignLeagueSlotsMutable,
  maxSurplusOverSlots,
  playerTokensFromLean,
  replacementLevelsFromSlotValuesPercentile,
  replacementLevelsFromSlotValues,
  sumDemand,
} from "../lib/fantasyRosterSlots";
import {
  REPLACEMENT_SLOTS_V2_MIN_BID,
  SLOT_REPLACEMENT_DEFAULT_PERCENTILE,
  SLOT_REPLACEMENT_PERCENTILE,
} from "./replacementSlotsV2Config";
import type { ReplacementSlotsV2Result } from "./replacementSlotsV2Types";
import {
  buildRosteredCandidates,
  buildSurplusBasisMap,
  buildUndraftedCandidates,
  computeTotalSurplusMass,
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
  }
): ReplacementSlotsV2Result {
  const deterministic = Boolean(options?.deterministic);
  const seed = options?.seed ?? 0;

  const rosterSlotKeys = new Set<string>();
  const initialDemand = buildLeagueSlotDemand(rosterSlots, numTeams);
  for (const k of initialDemand.keys()) rosterSlotKeys.add(k);

  const slotValues = new Map<string, number[]>();
  const demand = cloneDemandMap(initialDemand);

  const rosteredCandidates = buildRosteredCandidates(
    rostered,
    baselineById,
    deterministic,
    seed
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
          playerTokensFromLean(p),
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
    seed
  );
  const undraftedCandidateById = new Map(
    undraftedCandidates.map((c) => [c.player_id, c] as const)
  );

  const undraftedAssignedIds = new Set<string>();
  const undraftedSlotValues = new Map<string, number[]>();

  for (const c of undraftedCandidates) {
    if (sumDemand(demand) <= 0) break;
    const before = sumDemand(demand);
    greedyAssignLeagueSlotsMutable(
      [c],
      demand,
      slotValues,
      rosterSlotKeys,
      {
        deterministic,
        seed,
        onAssign: (_playerId, slotKey, baseline) => {
          const arr = undraftedSlotValues.get(slotKey) ?? [];
          arr.push(baseline);
          undraftedSlotValues.set(slotKey, arr);
        },
      }
    );
    const after = sumDemand(demand);
    if (after < before) undraftedAssignedIds.add(c.player_id);
  }

  const replacement_values_by_slot_or_position =
    replacementLevelsFromSlotValuesPercentile(
      undraftedSlotValues,
      rosterSlotKeys,
      SLOT_REPLACEMENT_PERCENTILE,
      SLOT_REPLACEMENT_DEFAULT_PERCENTILE
    );

  const surplus_cash = Math.max(
    0,
    budgetRemaining - remaining_slots * REPLACEMENT_SLOTS_V2_MIN_BID
  );

  const total_surplus_mass = computeTotalSurplusMass({
    assignedIds: undraftedAssignedIds,
    candidateById: undraftedCandidateById,
    replacementValues: replacement_values_by_slot_or_position,
    rosterSlotKeys,
  });

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

  const playerIdToSurplusBasis = buildSurplusBasisMap(
    undrafted,
    replacement_values_by_slot_or_position,
    rosterSlotKeys
  );

  const pool_value_remaining = total_surplus_mass;

  return {
    inflation_raw,
    inflation_factor_precap,
    pool_value_remaining,
    playerIdToSurplusBasis,
    draftablePoolSize,
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
