import { computeReplacementSlotsV2 } from "./replacementSlotsV2";
import {
  clampInflation,
  computeBudgetRemaining,
  tryBuildSurplusPlan,
  type SurplusPlan,
} from "./inflationPrimitives";
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  InflationModel,
  LeanPlayer,
  RosterSlot,
  ValuationResponse,
} from "../types/brain";

export type { SurplusPlan };
export { clampInflation, computeBudgetRemaining, tryBuildSurplusPlan };

export type InflationModelSelection = {
  inflationModelEffective: InflationModel;
  poolValueRemaining: number;
  rawInflationFactor: number;
  replacementValue: number;
  v2Meta: Partial<ValuationResponse>;
  v2Result: ReturnType<typeof computeReplacementSlotsV2> | null;
};

export function selectInflationModel(params: {
  requestedModel: InflationModel;
  scoped: LeanPlayer[];
  undraftedFull: LeanPlayer[];
  byValueFull: LeanPlayer[];
  draftedPlayers: DraftedPlayer[];
  rosterSlots: RosterSlot[];
  numTeams: number;
  budgetRemaining: number;
  options?: CalculateInflationOptions;
  poolValueFull: number;
  getPlayerId: (p: LeanPlayer) => string;
  minAuctionBid: number;
  defaultSurplusDraftablePoolMultiplier: number;
}): InflationModelSelection {
  const {
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
    minAuctionBid,
    defaultSurplusDraftablePoolMultiplier,
  } = params;

  if (requestedModel === "replacement_slots_v2") {
    const rostered = options?.rosteredPlayersForSlots ?? draftedPlayers;
    const baselineById = new Map<string, number>();
    for (const p of scoped) {
      baselineById.set(getPlayerId(p), p.value || 0);
    }
    const v2Result = computeReplacementSlotsV2(
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
    return {
      inflationModelEffective: "replacement_slots_v2",
      poolValueRemaining: v2Result.pool_value_remaining,
      rawInflationFactor: v2Result.inflation_factor_precap,
      replacementValue: 0,
      v2Meta: {
        remaining_slots: v2Result.remaining_slots,
        min_bid: v2Result.min_bid,
        surplus_cash: v2Result.surplus_cash,
        total_surplus_mass: v2Result.total_surplus_mass,
        draftable_pool_size: v2Result.draftablePoolSize,
        replacement_values_by_slot_or_position:
          v2Result.replacement_values_by_slot_or_position,
        fallback_reason: v2Result.fallback_reason,
      },
      v2Result,
    };
  }

  const surplusPlan =
    requestedModel === "surplus_slots_v1"
      ? tryBuildSurplusPlan({
          byValueFull,
          undraftedCount: undraftedFull.length,
          remainingSlots: options?.remainingLeagueSlots ?? -1,
          budgetRemaining,
          minAuctionBid,
          surplusDraftablePoolMultiplier:
            options?.surplusDraftablePoolMultiplier ??
            defaultSurplusDraftablePoolMultiplier,
        })
      : null;

  if (surplusPlan) {
    return {
      inflationModelEffective: "surplus_slots_v1",
      poolValueRemaining: surplusPlan.poolSurplusSum,
      rawInflationFactor:
        surplusPlan.poolSurplusSum > 0
          ? surplusPlan.surplusCash / surplusPlan.poolSurplusSum
          : 1,
      replacementValue: surplusPlan.replacementValue,
      v2Meta: {},
      v2Result: null,
    };
  }

  return {
    inflationModelEffective: "global_v1",
    poolValueRemaining: poolValueFull,
    rawInflationFactor: poolValueFull > 0 ? budgetRemaining / poolValueFull : 1,
    replacementValue: 0,
    v2Meta: {},
    v2Result: null,
  };
}

export function computeInflationIndexVsOpeningAuction(params: {
  inflationModelEffective: InflationModel;
  v2Result: ReturnType<typeof computeReplacementSlotsV2> | null;
  options?: CalculateInflationOptions;
  draftedPlayers: DraftedPlayer[];
  scoped: LeanPlayer[];
  rosterSlots: RosterSlot[];
  numTeams: number;
  budgetRemaining: number;
  inflationFactor: number;
  getPlayerId: (p: LeanPlayer) => string;
}): number | undefined {
  const {
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
  } = params;
  if (inflationModelEffective !== "replacement_slots_v2" || !v2Result) {
    return undefined;
  }
  const rostered = options?.rosteredPlayersForSlots ?? draftedPlayers;
  const auctionAcquiredIds = new Set(
    draftedPlayers.filter((d) => d.is_keeper !== true).map((d) => d.player_id)
  );
  const rosteredOpen = rostered.filter((r) => !auctionAcquiredIds.has(r.player_id));
  const offBoardOpen = new Set(rosteredOpen.map((r) => r.player_id));
  for (const pid of options?.additionalDraftedIds ?? []) {
    offBoardOpen.add(pid);
  }
  const undraftedOpen = scoped.filter((p) => !offBoardOpen.has(getPlayerId(p)));
  const auctionSpend = draftedPlayers
    .filter((d) => d.is_keeper !== true)
    .reduce((sum, d) => sum + (d.paid ?? 0), 0);
  const budgetOpen = Math.max(0, budgetRemaining + auctionSpend);
  const baselineByIdOpen = new Map<string, number>();
  for (const p of scoped) {
    baselineByIdOpen.set(getPlayerId(p), p.value || 0);
  }
  const v2Open = computeReplacementSlotsV2(
    undraftedOpen,
    rosteredOpen,
    rosterSlots,
    numTeams,
    budgetOpen,
    baselineByIdOpen,
    {
      deterministic: options?.deterministic,
      seed: options?.seed,
    }
  );
  let openClamped = clampInflation(
    v2Open.inflation_factor_precap,
    options?.inflationCap,
    options?.inflationFloor
  );
  if (v2Open.skip_inflation_clamp) {
    openClamped = {
      inflation_raw: v2Open.inflation_raw,
      inflation_factor: v2Open.inflation_factor_precap,
      inflation_bounded_by: "none",
    };
  }
  const fOpen = openClamped.inflation_factor;
  if (fOpen > 1e-9 && Number.isFinite(inflationFactor)) {
    const ratio = inflationFactor / fOpen;
    if (Number.isFinite(ratio) && ratio > 0) {
      return parseFloat(ratio.toFixed(4));
    }
  }
  return undefined;
}
