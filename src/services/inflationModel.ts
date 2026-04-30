import { computeReplacementSlotsV2 } from "./replacementSlotsV2";
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  InflationBoundedBy,
  InflationModel,
  LeanPlayer,
  RosterSlot,
  ValuationResponse,
} from "../types/brain";

export type SurplusPlan = {
  replacementValue: number;
  poolSurplusSum: number;
  surplusCash: number;
};

export type InflationModelSelection = {
  inflationModelEffective: InflationModel;
  poolValueRemaining: number;
  rawInflationFactor: number;
  replacementValue: number;
  v2Meta: Partial<ValuationResponse>;
  v2Result: ReturnType<typeof computeReplacementSlotsV2> | null;
};

export function clampInflation(
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

export function computeBudgetRemaining(params: {
  draftedPlayers: DraftedPlayer[];
  totalBudgetPerTeam: number;
  numTeams: number;
  budgetByTeamId?: Record<string, number>;
  additionalSpent?: number;
}): number {
  const {
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId,
    additionalSpent,
  } = params;
  if (budgetByTeamId && Object.keys(budgetByTeamId).length > 0) {
    return Object.values(budgetByTeamId).reduce((sum, v) => sum + v, 0);
  }
  const totalLeagueBudget = totalBudgetPerTeam * numTeams;
  const budgetSpent = draftedPlayers.reduce((sum, dp) => sum + (dp.paid ?? 0), 0);
  return Math.max(0, totalLeagueBudget - budgetSpent - (additionalSpent ?? 0));
}

export function tryBuildSurplusPlan(params: {
  byValueFull: LeanPlayer[];
  undraftedCount: number;
  remainingSlots: number;
  budgetRemaining: number;
  minAuctionBid: number;
  surplusDraftablePoolMultiplier: number;
}): SurplusPlan | null {
  const {
    byValueFull,
    undraftedCount,
    remainingSlots,
    budgetRemaining,
    minAuctionBid,
    surplusDraftablePoolMultiplier,
  } = params;
  if (remainingSlots <= 0 || undraftedCount === 0) return null;
  const k = Math.min(
    undraftedCount,
    Math.ceil(remainingSlots * surplusDraftablePoolMultiplier)
  );
  if (k < 1) return null;
  const draftable = byValueFull.slice(0, k);
  const replacementValue = draftable[draftable.length - 1]?.value ?? 0;
  let poolSurplusSum = 0;
  for (const p of draftable) {
    poolSurplusSum += Math.max(0, (p.value || 0) - replacementValue);
  }
  if (poolSurplusSum <= 0) return null;
  const surplusCash = Math.max(0, budgetRemaining - remainingSlots * minAuctionBid);
  return { replacementValue, poolSurplusSum, surplusCash };
}

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
