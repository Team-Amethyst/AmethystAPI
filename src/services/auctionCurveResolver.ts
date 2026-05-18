import {
  buildTieredSurplusDollars,
  TIERED_SURPLUS_V1,
  type AuctionCurveModel,
  type TierSurplusConfig,
  type TieredSurplusTier,
} from "./auctionCurveModel";
import { applyTieredSurplusSmoothing } from "./auctionSurplusSmoothing";
import type { Stage3bCalibration } from "./stage3bPitcherCalibration";
import {
  applyTargetedSpSurplusFloors,
  buildPitcherAuctionSlotById,
  buildBucketTieredSurplusDollars,
} from "./stage3bPitcherAllocation";
import { STAGE3B_OPENING_DRAFTABLE_DEMAND_SLOTS } from "./replacementSlotsV2Config";

export type LeagueBoardPhase =
  | "fresh"
  | "keeper_pre_draft"
  | "mid_draft"
  | "late_draft"
  | "near_complete";

export type SurplusAllocationMode = "linear" | "tiered_soft" | "tiered_keeper";

/** @deprecated use STAGE3B_OPENING_DRAFTABLE_DEMAND_SLOTS */
export const STAGE3B_PRE_DRAFT_SURPLUS_POOL_CAP =
  STAGE3B_OPENING_DRAFTABLE_DEMAND_SLOTS;

export interface AuctionCurveLeagueState {
  activeSlotCapacity: number;
  activeRosteredCount: number;
  remainingActiveSlots: number;
  openSlotRatio: number;
  keeperCount: number;
  draftedAuctionCount: number;
  minTaxiPoolCount: number;
  numTeams: number;
  totalBudgetPerTeam: number;
  leagueAuctionDollars: number;
  remainingAuctionDollars: number;
  minimumReserveDollars: number;
  allocatableSurplusDollars: number;
  totalSurplusMass: number;
  inflationRaw: number;
  inflationFactor: number;
}

export interface LinearSpreadPreview {
  top1: number;
  top5Avg: number;
  top10Avg: number;
  top25Avg: number;
  top10Spread: number;
  top25Spread: number;
}

export interface AuctionCurveResolution {
  requestedModel: AuctionCurveModel;
  /** Response `auction_curve_model` (may be adaptive_surplus_v1 while allocating linear/tiered). */
  responseModel: AuctionCurveModel;
  reason: string;
  phase: LeagueBoardPhase;
  internalMode: SurplusAllocationMode;
  weights: TierSurplusConfig;
  curveInputs: Record<string, number | string | boolean>;
  guardrails: Record<string, number>;
  linearPreview: LinearSpreadPreview;
  top10LinearSpread: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function classifyLeagueBoardPhase(state: AuctionCurveLeagueState): LeagueBoardPhase {
  const fillRatio =
    state.activeSlotCapacity > 0
      ? 1 - state.openSlotRatio
      : 1;
  if (state.remainingActiveSlots <= 0 || fillRatio >= 0.97) {
    return "near_complete";
  }
  if (state.draftedAuctionCount === 0 && state.keeperCount === 0) {
    return "fresh";
  }
  if (state.draftedAuctionCount === 0 && state.keeperCount > 0) {
    return "keeper_pre_draft";
  }
  if (fillRatio < 0.4) return "mid_draft";
  if (fillRatio < 0.88) return "late_draft";
  return "near_complete";
}

/** Linear auction preview on draftable ids (same formula as linear_v1 rows). */
export function previewLinearSurplusAuction(
  draftablePlayerIds: readonly string[],
  surplusBasisById: Map<string, number>,
  inflationFactor: number,
  minBid: number
): LinearSpreadPreview {
  const vals = draftablePlayerIds
    .map((id) => minBid + inflationFactor * (surplusBasisById.get(id) ?? 0))
    .filter((v) => v > minBid)
    .sort((a, b) => b - a);
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
  const top1 = vals[0] ?? minBid;
  const top10 = vals[9] ?? vals[vals.length - 1] ?? minBid;
  const top25 = vals[24] ?? vals[vals.length - 1] ?? minBid;
  return {
    top1,
    top5Avg: avg(vals.slice(0, 5)),
    top10Avg: avg(vals.slice(0, 10)),
    top25Avg: avg(vals.slice(0, 25)),
    top10Spread: top1 - top10,
    top25Spread: top1 - top25,
  };
}

/**
 * Zero-keeper boards with many open slots: plain linear surplus spread collapses
 * the star tier (e.g. 12-team empty draft tops ~$17). Use tiered allocation instead.
 */
export function isFreshBoardLinearOverCompressed(
  state: AuctionCurveLeagueState & { draftablePoolSize: number },
  preview: LinearSpreadPreview
): boolean {
  if (state.keeperCount > 0 || state.draftedAuctionCount > 0) return false;
  if (state.allocatableSurplusDollars <= 0 || state.draftablePoolSize <= 0) {
    return false;
  }
  /**
   * True-empty auction drafts (wide open slot demand): always use opening tiered
   * surplus — linear preview top1 often overstates final draftable auction values.
   */
  const largeTrueEmptyOpening =
    state.remainingActiveSlots >= 200 || state.draftablePoolSize >= 200;
  if (largeTrueEmptyOpening) return true;

  const largeBoard =
    state.remainingActiveSlots >= 100 || state.draftablePoolSize >= 100;
  if (!largeBoard) return false;
  if (preview.top1 >= 30 && preview.top10Spread >= 4) return false;
  if (preview.top1 < 28) return true;
  const spreadFloor = Math.max(2.5, state.allocatableSurplusDollars * 0.004);
  return preview.top10Spread < spreadFloor;
}

export function isLinearCurveOverCompressedState(
  state: AuctionCurveLeagueState & { draftablePoolSize: number },
  preview: LinearSpreadPreview
): boolean {
  if (state.keeperCount === 0) return false;
  if (state.allocatableSurplusDollars <= 0 || state.draftablePoolSize <= 0) {
    return false;
  }
  const massRatio =
    state.totalSurplusMass / Math.max(state.allocatableSurplusDollars, 1);
  if (massRatio < 2.5) return false;
  const spreadFloor = Math.max(
    1.25,
    state.allocatableSurplusDollars * 0.0035
  );
  if (preview.top10Spread >= spreadFloor) return false;
  return state.keeperCount >= Math.max(8, state.numTeams);
}

export function computeAdaptiveTierWeights(
  state: AuctionCurveLeagueState & { draftablePoolSize: number },
  phase: LeagueBoardPhase,
  massRatio: number
): TierSurplusConfig {
  if (phase === "fresh") {
    return {
      starFraction: TIERED_SURPLUS_V1.starFraction,
      starterFraction: TIERED_SURPLUS_V1.starterFraction,
      starWeight: 1,
      starterWeight: 1,
      depthWeight: 1,
      fringeWeight: TIERED_SURPLUS_V1.fringeWeight,
    };
  }

  const keeperShare = clamp(
    state.keeperCount / Math.max(1, state.activeRosteredCount),
    0,
    1
  );
  const compression = clamp(massRatio / 6, 0, 1);
  let starWeight = 1 + keeperShare * compression * 1.75;

  const manySlotsOpen = state.remainingActiveSlots >= 70;
  if (phase === "mid_draft") {
    starWeight = 1 + (starWeight - 1) * (manySlotsOpen ? 0.75 : 0.5);
  } else if (phase === "late_draft") {
    starWeight = 1 + (starWeight - 1) * (manySlotsOpen ? 0.82 : 0.5);
  }
  if (phase === "near_complete") {
    starWeight = 1 + (starWeight - 1) * 0.25;
  }

  return {
    starFraction: TIERED_SURPLUS_V1.starFraction,
    starterFraction: TIERED_SURPLUS_V1.starterFraction,
    starWeight: clamp(starWeight, 1, 2.75),
    starterWeight: 1,
    depthWeight: TIERED_SURPLUS_V1.depthWeight,
    fringeWeight: TIERED_SURPLUS_V1.fringeWeight,
  };
}

export function resolveAuctionCurveForLeague(params: {
  requestedModel: AuctionCurveModel;
  state: AuctionCurveLeagueState & { draftablePoolSize: number };
  linearPreview: LinearSpreadPreview;
  stage3bCalibration?: Stage3bCalibration;
}): AuctionCurveResolution {
  const { requestedModel, state, linearPreview } = params;
  const phase = classifyLeagueBoardPhase(state);
  const massRatio =
    state.totalSurplusMass / Math.max(state.allocatableSurplusDollars, 1);
  const compressed = isLinearCurveOverCompressedState(state, linearPreview);
  /** After UTIL/BN surplus fix, mass ratio is often << 2.5; tiered allocation avoids linear inflation blow-up. */
  const thinTrueSurplusMass =
    massRatio < 2.5 &&
    state.keeperCount > 0 &&
    phase !== "fresh" &&
    phase !== "near_complete";

  const freshLinearOverCompressed = isFreshBoardLinearOverCompressed(
    state,
    linearPreview
  );

  const curveInputs: Record<string, number | string | boolean> = {
    phase,
    active_slot_capacity: state.activeSlotCapacity,
    active_rostered_count: state.activeRosteredCount,
    remaining_active_slots: state.remainingActiveSlots,
    open_slot_ratio: parseFloat(state.openSlotRatio.toFixed(4)),
    keeper_count: state.keeperCount,
    drafted_auction_count: state.draftedAuctionCount,
    min_taxi_pool_count: state.minTaxiPoolCount,
    allocatable_surplus_dollars: state.allocatableSurplusDollars,
    total_surplus_mass: state.totalSurplusMass,
    surplus_mass_ratio: parseFloat(massRatio.toFixed(4)),
    inflation_raw: state.inflationRaw,
    inflation_factor: state.inflationFactor,
    linear_top10_spread: parseFloat(linearPreview.top10Spread.toFixed(4)),
    linear_top1: parseFloat(linearPreview.top1.toFixed(2)),
    linear_over_compressed: compressed,
    thin_true_surplus_mass: thinTrueSurplusMass,
    fresh_linear_over_compressed: freshLinearOverCompressed,
  };

  let internalMode: SurplusAllocationMode = "linear";
  let reason = "default_linear";

  if (requestedModel === "linear_v1") {
    internalMode = "linear";
    reason = "manual_linear_v1";
  } else if (requestedModel === "tiered_surplus_v1") {
    internalMode = phase === "fresh" ? "tiered_soft" : "tiered_keeper";
    reason = "manual_tiered_surplus_v1";
  } else {
    if (phase === "fresh") {
      if (freshLinearOverCompressed) {
        internalMode = "tiered_soft";
        reason = "fresh_empty_opening_tiered";
      } else {
        internalMode = "linear";
        reason = "fresh_board_linear";
      }
    } else if (phase === "near_complete") {
      if (
        massRatio < 2.5 &&
        state.allocatableSurplusDollars > 0 &&
        state.draftablePoolSize > 0
      ) {
        internalMode = "tiered_soft";
        reason = "near_complete_thin_true_surplus_tiered_soft";
      } else {
        internalMode = "linear";
        reason = "near_complete_linear";
      }
    } else if (compressed || thinTrueSurplusMass) {
      internalMode =
        phase === "keeper_pre_draft" ? "tiered_keeper" : "tiered_soft";
      reason =
        phase === "keeper_pre_draft"
          ? compressed
            ? "keeper_compressed_linear_tiered"
            : "keeper_thin_true_surplus_tiered"
          : compressed
            ? "mid_draft_compressed_tiered_soft"
            : "mid_draft_thin_true_surplus_tiered_soft";
    } else {
      internalMode = "linear";
      reason = "healthy_linear_spread";
    }
  }

  const midSpread = params.stage3bCalibration?.midDraftSpread;
  if (
    midSpread?.enabled &&
    midSpread.preferTieredSoft &&
    internalMode === "linear" &&
    reason === "healthy_linear_spread" &&
    phase !== "fresh" &&
    phase !== "near_complete"
  ) {
    const lo = midSpread.minRemainingSlots ?? 35;
    const hi = midSpread.maxRemainingSlots ?? 85;
    if (
      state.remainingActiveSlots >= lo &&
      state.remainingActiveSlots <= hi
    ) {
      internalMode = "tiered_soft";
      reason = "stage3b_mid_draft_tiered_spread";
    }
  }

  if (requestedModel === "tiered_surplus_v1" && phase === "fresh") {
    internalMode = "tiered_soft";
    reason = "manual_tiered_fresh_softened";
  }

  const weights = computeAdaptiveTierWeights(state, phase, massRatio);
  if (internalMode === "linear") {
    weights.starWeight = 1;
    weights.starterWeight = 1;
    weights.depthWeight = 1;
  } else if (reason === "fresh_empty_opening_tiered") {
    weights.starFraction = 0.12;
    weights.starterFraction = 0.22;
    weights.starWeight = TIERED_SURPLUS_V1.starWeight;
    weights.starterWeight = TIERED_SURPLUS_V1.starterWeight;
    weights.depthWeight = TIERED_SURPLUS_V1.depthWeight;
    weights.fringeWeight = TIERED_SURPLUS_V1.fringeWeight;
  } else if (internalMode === "tiered_soft") {
    weights.starWeight = clamp((weights.starWeight ?? 1) * 0.65, 1, 1.85);
  }

  const guardrails = computeSurplusGuardrailCaps(state, phase);

  return {
    requestedModel,
    responseModel: requestedModel,
    reason,
    phase,
    internalMode,
    weights,
    curveInputs,
    guardrails,
    linearPreview,
    top10LinearSpread: linearPreview.top10Spread,
  };
}

export function computeSurplusGuardrailCaps(
  state: AuctionCurveLeagueState,
  phase: LeagueBoardPhase,
  minBid = 1
): Record<string, number> {
  const leagueCap = state.leagueAuctionDollars;
  const perTeam = state.totalBudgetPerTeam;
  let maxTopAuction = Math.min(
    leagueCap * 0.16,
    perTeam * 0.48,
    minBid + state.allocatableSurplusDollars * 0.38
  );
  if (phase === "keeper_pre_draft") {
    maxTopAuction = Math.min(Math.max(maxTopAuction, 28), 44);
  } else if (
    phase === "fresh" &&
    state.keeperCount === 0 &&
    state.remainingActiveSlots >= 200
  ) {
    maxTopAuction = Math.min(maxTopAuction, perTeam * 0.135, 36);
  } else if (phase === "fresh" || state.keeperCount === 0) {
    maxTopAuction = Math.min(maxTopAuction, perTeam * 0.17, 42);
  }
  const maxTop10Avg = Math.min(
    state.remainingAuctionDollars * 0.12,
    perTeam * 0.35
  );
  const maxRecBidRatio = 1.12;
  return {
    max_top_player_auction_value: parseFloat(maxTopAuction.toFixed(2)),
    max_top10_avg_auction_value: parseFloat(maxTop10Avg.toFixed(2)),
    max_recommended_bid_vs_auction_ratio: maxRecBidRatio,
    max_top_surplus_share_of_allocatable: 0.4,
    max_top_surplus_share_of_league_budget: 0.16,
  };
}

function sumMapValues(map: Map<string, number>): number {
  let sum = 0;
  for (const v of map.values()) sum += v;
  return sum;
}

/** Cap top surplus share; preserves total surplus when input already sums to `surplusCash`. */
export function applySurplusGuardrails(params: {
  dollarsByPlayerId: Map<string, number>;
  surplusCash: number;
  minBid: number;
  guardrails: Record<string, number>;
  phase: LeagueBoardPhase;
  keeperCount: number;
}): {
  dollarsByPlayerId: Map<string, number>;
  guardrailsApplied: string[];
  conservationDelta: number;
} {
  const applied: string[] = [];
  let map = new Map(params.dollarsByPlayerId);
  const maxTopSurplus = Math.max(
    0,
    (params.guardrails.max_top_player_auction_value ?? 999) - params.minBid
  );

  const priorSum = sumMapValues(map);
  if (Math.abs(priorSum - params.surplusCash) > 0.5 && priorSum > 0) {
    const scale = params.surplusCash / priorSum;
    const scaled = new Map<string, number>();
    for (const [id, d] of map) scaled.set(id, d * scale);
    map = scaled;
    applied.push("normalize_input_to_surplus_cash");
  }

  for (let iter = 0; iter < 12; iter++) {
    let maxVal = 0;
    for (const v of map.values()) if (v > maxVal) maxVal = v;
    if (maxVal <= maxTopSurplus + 1e-6) break;

    let trimmed = 0;
    const next = new Map<string, number>();
    for (const [id, d] of map) {
      if (d > maxTopSurplus) {
        trimmed += d - maxTopSurplus;
        next.set(id, maxTopSurplus);
      } else {
        next.set(id, d);
      }
    }
    map = next;
    if (trimmed <= 0) break;

    const headroom = maxTopSurplus * 0.85;
    const recipients = [...map.entries()].filter(([, d]) => d < headroom);
    const room = recipients.reduce(
      (s, [, d]) => s + (headroom - d),
      0
    );
    if (room > 0) {
      const give = Math.min(trimmed, room);
      for (const [id, d] of recipients) {
        const add = give * ((headroom - d) / room);
        map.set(id, d + add);
      }
      trimmed -= give;
    }
    if (trimmed > 0.05) {
      const rec = [...map.entries()].filter(([, d]) => d < maxTopSurplus);
      const recSum = rec.reduce((s, [, d]) => s + d, 0);
      if (recSum > 0) {
        for (const [id, d] of rec) {
          map.set(id, d + trimmed * (d / recSum));
        }
      }
    }
    applied.push("clamp_top_and_redistribute_trim");
  }

  let sumAfter = sumMapValues(map);
  let missing = params.surplusCash - sumAfter;
  if (missing > 0.05) {
    const receivers = [...map.entries()].filter(([, d]) => d < maxTopSurplus - 1e-6);
    const room = receivers.reduce((s, [, d]) => s + (maxTopSurplus - d), 0);
    if (room > 0) {
      const give = Math.min(missing, room);
      for (const [id, d] of receivers) {
        map.set(id, d + give * ((maxTopSurplus - d) / room));
      }
      applied.push("fill_remaining_surplus_under_cap");
      sumAfter = sumMapValues(map);
      missing = params.surplusCash - sumAfter;
    }
  }

  const delta = missing;

  return {
    dollarsByPlayerId: map,
    guardrailsApplied: applied,
    conservationDelta: parseFloat(delta.toFixed(4)),
  };
}

export function allocateSurplusForCurve(params: {
  resolution: AuctionCurveResolution;
  surplusCash: number;
  minBid: number;
  draftablePlayerIds: readonly string[];
  surplusBasisById: Map<string, number>;
  fringePlayerIds?: readonly string[];
  hybridLiftById?: Map<string, number>;
  assignedSlotById?: Map<string, string>;
  tokensById?: Map<string, readonly string[]>;
  positionById?: Map<string, string>;
  stage3bCalibration?: Stage3bCalibration;
  state: AuctionCurveLeagueState;
}): {
  dollarsByPlayerId: Map<string, number>;
  tierByPlayerId: Map<string, TieredSurplusTier>;
  weightByPlayerId: Map<string, number>;
  guardrailsApplied: string[];
  conservationDelta: number;
} {
  const {
    resolution,
    surplusCash,
    minBid,
    draftablePlayerIds,
    surplusBasisById,
    fringePlayerIds,
    state,
  } = params;

  let surplusDraftableIds = draftablePlayerIds;
  const tieredOpeningCap =
    resolution.reason === "fresh_empty_opening_tiered"
      ? Math.min(
          draftablePlayerIds.length,
          Math.max(
            STAGE3B_PRE_DRAFT_SURPLUS_POOL_CAP,
            Math.round(state.numTeams * 17.5),
          ),
        )
      : resolution.reason === "fresh_board_tiered_spread"
        ? STAGE3B_PRE_DRAFT_SURPLUS_POOL_CAP
        : null;
  if (
    tieredOpeningCap != null &&
    draftablePlayerIds.length > tieredOpeningCap
  ) {
    surplusDraftableIds = [...draftablePlayerIds]
      .sort(
        (a, b) =>
          (surplusBasisById.get(b) ?? 0) - (surplusBasisById.get(a) ?? 0)
      )
      .slice(0, tieredOpeningCap);
  }

  if (resolution.internalMode === "linear" || surplusCash <= 0) {
    return {
      dollarsByPlayerId: new Map(),
      tierByPlayerId: new Map(),
      weightByPlayerId: new Map(),
      guardrailsApplied: [],
      conservationDelta: 0,
    };
  }

  const pitcherSlotById = buildPitcherAuctionSlotById({
    playerIds: surplusDraftableIds,
    assignedSlotById: params.assignedSlotById,
    tokensById: params.tokensById,
    positionById: params.positionById,
  });
  const prb = params.stage3bCalibration?.pitcherRelativeBudget;
  const tiered = prb?.enabled
    ? buildBucketTieredSurplusDollars({
        surplusCash,
        draftablePlayerIds: surplusDraftableIds,
        surplusBasisById,
        fringePlayerIds,
        hitterTierConfig: resolution.weights,
        pitcherRelative: prb,
        hybridLiftById: params.hybridLiftById,
        assignedSlotById: pitcherSlotById,
        pitcherAuction: params.stage3bCalibration?.pitcherAuction,
      })
    : buildTieredSurplusDollars({
        surplusCash,
        draftablePlayerIds: surplusDraftableIds,
        surplusBasisById,
        fringePlayerIds,
        tierConfig: resolution.weights,
        hybridLiftById: params.hybridLiftById,
        assignedSlotById: pitcherSlotById,
        pitcherAuction: params.stage3bCalibration?.pitcherAuction,
      });

  const smoothed = applyTieredSurplusSmoothing({
    tieredDollars: tiered.dollarsByPlayerId,
    surplusCash,
    draftablePlayerIds: surplusDraftableIds,
    surplusBasisById,
    internalMode: resolution.internalMode,
    phase: resolution.phase,
    remainingActiveSlots: state.remainingActiveSlots,
    tieredFractionOverride:
      params.stage3bCalibration?.midDraftSpread?.tieredFraction,
  });

  const guarded = applySurplusGuardrails({
    dollarsByPlayerId: smoothed.dollarsByPlayerId,
    surplusCash,
    minBid,
    guardrails: resolution.guardrails,
    phase: resolution.phase,
    keeperCount: state.keeperCount,
  });

  const finalDollars = new Map(guarded.dollarsByPlayerId);
  applyTargetedSpSurplusFloors({
    dollarsByPlayerId: finalDollars,
    tierByPlayerId: tiered.tierByPlayerId,
    surplusCash,
    draftablePlayerIds: surplusDraftableIds,
    surplusBasisById,
    assignedSlotById: params.assignedSlotById,
    tokensById: params.tokensById,
    positionById: params.positionById,
    pitcherAuction: params.stage3bCalibration?.pitcherAuction,
  });

  return {
    dollarsByPlayerId: finalDollars,
    tierByPlayerId: tiered.tierByPlayerId,
    weightByPlayerId: tiered.weightByPlayerId,
    guardrailsApplied: [...smoothed.applied, ...guarded.guardrailsApplied],
    conservationDelta: guarded.conservationDelta,
  };
}
