import {
  buildTieredSurplusDollars,
  TIERED_SURPLUS_V1,
  type AuctionCurveModel,
  type TierSurplusConfig,
  type TieredSurplusTier,
} from "./auctionCurveModel";

export type LeagueBoardPhase =
  | "fresh"
  | "keeper_pre_draft"
  | "mid_draft"
  | "late_draft"
  | "near_complete";

export type SurplusAllocationMode = "linear" | "tiered_soft" | "tiered_keeper";

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

  if (phase === "mid_draft" || phase === "late_draft") {
    starWeight = 1 + (starWeight - 1) * 0.5;
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
}): AuctionCurveResolution {
  const { requestedModel, state, linearPreview } = params;
  const phase = classifyLeagueBoardPhase(state);
  const massRatio =
    state.totalSurplusMass / Math.max(state.allocatableSurplusDollars, 1);
  const compressed = isLinearCurveOverCompressedState(state, linearPreview);

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
      internalMode = "linear";
      reason = "fresh_board_linear";
    } else if (phase === "near_complete") {
      internalMode = "linear";
      reason = "near_complete_linear";
    } else if (compressed) {
      internalMode =
        phase === "keeper_pre_draft" ? "tiered_keeper" : "tiered_soft";
      reason =
        phase === "keeper_pre_draft"
          ? "keeper_compressed_linear_tiered"
          : "mid_draft_compressed_tiered_soft";
    } else {
      internalMode = "linear";
      reason = "healthy_linear_spread";
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
  if (phase === "fresh" || state.keeperCount === 0) {
    maxTopAuction = Math.min(maxTopAuction, perTeam * 0.17, 42);
  }
  if (phase === "keeper_pre_draft") {
    maxTopAuction = Math.min(Math.max(maxTopAuction, 28), 48);
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

/** Cap top player and redistribute excess to others (conserves total surplus mass). */
function capTopSurplusAndRedistribute(
  map: Map<string, number>,
  maxTopSurplus: number
): { map: Map<string, number>; capped: boolean } {
  let topId: string | null = null;
  let topSurplus = -1;
  for (const [id, d] of map) {
    if (d > topSurplus) {
      topSurplus = d;
      topId = id;
    }
  }
  if (topId == null || topSurplus <= maxTopSurplus + 1e-6) {
    return { map: new Map(map), capped: false };
  }
  const excess = topSurplus - maxTopSurplus;
  const out = new Map(map);
  out.set(topId, maxTopSurplus);
  const others = [...out.entries()].filter(([id]) => id !== topId);
  const otherSum = others.reduce((s, [, d]) => s + d, 0);
  if (otherSum > 0) {
    for (const [id, d] of others) {
      out.set(id, d + excess * (d / otherSum));
    }
  }
  return { map: out, capped: true };
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

  let priorSum = sumMapValues(map);
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

  if (resolution.internalMode === "linear" || surplusCash <= 0) {
    return {
      dollarsByPlayerId: new Map(),
      tierByPlayerId: new Map(),
      weightByPlayerId: new Map(),
      guardrailsApplied: [],
      conservationDelta: 0,
    };
  }

  const tiered = buildTieredSurplusDollars({
    surplusCash,
    draftablePlayerIds,
    surplusBasisById,
    fringePlayerIds,
    tierConfig: resolution.weights,
  });

  const guarded = applySurplusGuardrails({
    dollarsByPlayerId: tiered.dollarsByPlayerId,
    surplusCash,
    minBid,
    guardrails: resolution.guardrails,
    phase: resolution.phase,
    keeperCount: state.keeperCount,
  });

  return {
    dollarsByPlayerId: guarded.dollarsByPlayerId,
    tierByPlayerId: tiered.tierByPlayerId,
    weightByPlayerId: tiered.weightByPlayerId,
    guardrailsApplied: guarded.guardrailsApplied,
    conservationDelta: guarded.conservationDelta,
  };
}
