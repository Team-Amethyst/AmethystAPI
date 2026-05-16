import { isReserveRosterSlotForEngine } from "../lib/rosteredPlayersForSlots";
import type { DraftedPlayer } from "../types/brain";
import type { ReplacementSlotsV2Result } from "./replacementSlotsV2Types";
import {
  resolveAuctionCurveModel,
  type AuctionCurveModel,
} from "./auctionCurveModel";
import {
  allocateSurplusForCurve,
  previewLinearSurplusAuction,
  resolveAuctionCurveForLeague,
  type AuctionCurveLeagueState,
  type AuctionCurveResolution,
} from "./auctionCurveResolver";

export type AuctionCurveDebugMeta = {
  auction_curve_model: AuctionCurveModel;
  auction_curve_reason: string;
  curve_inputs: Record<string, number | string | boolean>;
  curve_guardrails: Record<string, number>;
  curve_guardrails_applied?: string[];
  top10_linear_spread: number;
  selected_weights: Record<string, number>;
  surplus_conservation_delta?: number;
  internal_allocation_mode: string;
};

export function buildAuctionCurveLeagueState(params: {
  leagueSlotCapacity: number;
  remainingSlots: number;
  numTeams: number;
  totalBudgetPerTeam: number;
  budgetRemaining: number;
  v2: ReplacementSlotsV2Result;
  rosteredForSlots: DraftedPlayer[];
  draftedPlayers: DraftedPlayer[];
  additionalDraftedIds?: string[];
  inflationRaw: number;
  inflationFactor: number;
}): AuctionCurveLeagueState & { draftablePoolSize: number } {
  const keepers = params.rosteredForSlots.filter((p) => p.is_keeper).length;
  const activeRostered = params.rosteredForSlots.length;
  const draftedAuction = params.draftedPlayers.filter(
    (p) => !isReserveRosterSlotForEngine(p.roster_slot)
  ).length;
  const minBid = params.v2.min_bid;
  const minReserve = params.remainingSlots * minBid;
  const surplusCash = params.v2.surplus_cash;

  const slotEngineIds = new Set(params.rosteredForSlots.map((p) => p.player_id));
  let minTaxiPoolCount = 0;
  for (const id of params.additionalDraftedIds ?? []) {
    if (!slotEngineIds.has(id)) minTaxiPoolCount++;
  }

  const leagueAuctionDollars = params.numTeams * params.totalBudgetPerTeam;
  void params.budgetRemaining;

  return {
    activeSlotCapacity: params.leagueSlotCapacity,
    activeRosteredCount: activeRostered,
    remainingActiveSlots: params.remainingSlots,
    openSlotRatio:
      params.leagueSlotCapacity > 0
        ? params.remainingSlots / params.leagueSlotCapacity
        : 0,
    keeperCount: keepers,
    draftedAuctionCount: draftedAuction,
    minTaxiPoolCount,
    numTeams: params.numTeams,
    totalBudgetPerTeam: params.totalBudgetPerTeam,
    leagueAuctionDollars,
    remainingAuctionDollars: surplusCash + minReserve,
    minimumReserveDollars: minReserve,
    allocatableSurplusDollars: surplusCash,
    totalSurplusMass: params.v2.total_surplus_mass,
    inflationRaw: params.inflationRaw,
    inflationFactor: params.inflationFactor,
    draftablePoolSize: params.v2.draftablePoolSize,
  };
}

export function applyAuctionCurveToV2Result(params: {
  requestedModel: string | undefined;
  v2Result: ReplacementSlotsV2Result;
  undraftedFringeIds: string[];
  leagueState: AuctionCurveLeagueState & { draftablePoolSize: number };
  inflationFactor: number;
}): {
  v2ForRows: ReplacementSlotsV2Result;
  resolution: AuctionCurveResolution;
  debug: AuctionCurveDebugMeta;
} {
  const requested = resolveAuctionCurveModel(params.requestedModel);
  const { v2Result, leagueState, inflationFactor, undraftedFringeIds } = params;
  const minBid = v2Result.min_bid;

  const linearPreview = previewLinearSurplusAuction(
    v2Result.draftablePlayerIds,
    v2Result.playerIdToSurplusBasis,
    inflationFactor,
    minBid
  );

  const resolution = resolveAuctionCurveForLeague({
    requestedModel: requested,
    state: leagueState,
    linearPreview,
  });

  let v2ForRows = v2Result;
  let guardrailsApplied: string[] = [];
  let conservationDelta = 0;

  const canAllocate =
    v2Result.surplus_cash > 0 &&
    !v2Result.baselineOnly &&
    v2Result.fallback_reason !== "no_surplus_mass";

  if (canAllocate && resolution.internalMode !== "linear") {
    const alloc = allocateSurplusForCurve({
      resolution,
      surplusCash: v2Result.surplus_cash,
      minBid,
      draftablePlayerIds: v2Result.draftablePlayerIds,
      surplusBasisById: v2Result.playerIdToSurplusBasis,
      fringePlayerIds: undraftedFringeIds,
      state: leagueState,
    });
    guardrailsApplied = alloc.guardrailsApplied;
    conservationDelta = alloc.conservationDelta;
    v2ForRows = {
      ...v2Result,
      playerIdToSurplusDollars: alloc.dollarsByPlayerId,
      playerIdToSurplusTier: alloc.tierByPlayerId,
      playerIdToCurveWeight: alloc.weightByPlayerId,
    };
  }

  const cfg = resolution.weights;
  const debug: AuctionCurveDebugMeta = {
    auction_curve_model: resolution.responseModel,
    auction_curve_reason: resolution.reason,
    curve_inputs: resolution.curveInputs,
    curve_guardrails: resolution.guardrails,
    ...(guardrailsApplied.length ? { curve_guardrails_applied: guardrailsApplied } : {}),
    top10_linear_spread: resolution.top10LinearSpread,
    selected_weights: {
      star_fraction: cfg.starFraction ?? 0.1,
      starter_fraction: cfg.starterFraction ?? 0.25,
      star_weight: cfg.starWeight ?? 1,
      starter_weight: cfg.starterWeight ?? 1,
      depth_weight: cfg.depthWeight ?? 0.28,
      fringe_weight: cfg.fringeWeight ?? 0.06,
    },
    ...(conservationDelta !== 0 ? { surplus_conservation_delta: conservationDelta } : {}),
    internal_allocation_mode: resolution.internalMode,
  };

  return { v2ForRows, resolution, debug };
}
