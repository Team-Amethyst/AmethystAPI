import type { DraftPhaseIndicator, ValuedPlayer } from "../types/brain";
import { RECOMMENDED_BID_TUNING } from "./recommendedBidConfig";
import { baseLambdaClearingPrice, isPitcherPosition } from "./recommendedBidMath";

type BidCtx = {
  row: ValuedPlayer;
  draftPhase: DraftPhaseIndicator;
  depthFrac: number;
  minAuctionBid: number;
  nearAuctionOpenNeutral: boolean;
  a: number;
  r: number;
};

function dampLambda(
  L: number,
  position: string,
  draftPhase: DraftPhaseIndicator
): number {
  if (!isPitcherPosition(position)) return L;
  const damp =
    draftPhase === "early"
      ? RECOMMENDED_BID_TUNING.pitcher_lambda_damp.early
      : draftPhase === "mid"
        ? RECOMMENDED_BID_TUNING.pitcher_lambda_damp.mid
        : RECOMMENDED_BID_TUNING.pitcher_lambda_damp.late;
  return L * damp;
}

export function initialClearingPrice(L: number, a: number, r: number): number {
  return a + L * (r - a);
}

export function buildLambdaForRow(
  row: ValuedPlayer,
  draftPhase: DraftPhaseIndicator,
  depthFrac: number
): number {
  const L0 = baseLambdaClearingPrice(draftPhase, depthFrac);
  return dampLambda(L0, row.position, draftPhase);
}

export function applyEarlyEliteAnchorBoost(
  clearing: number,
  ctx: Pick<BidCtx, "draftPhase" | "depthFrac" | "a" | "r">
): number {
  if (ctx.draftPhase === "early" && ctx.depthFrac < 0.06) {
    return clearing + RECOMMENDED_BID_TUNING.early_elite_anchor_boost * (ctx.r - ctx.a);
  }
  return clearing;
}

export function applyLateSqueeze(
  clearing: number,
  ctx: Pick<BidCtx, "draftPhase" | "depthFrac" | "minAuctionBid">
): number {
  if (ctx.draftPhase !== "late") return clearing;
  const squeeze = 0.5 + 0.5 * (1 - ctx.depthFrac);
  return (
    ctx.minAuctionBid +
    (clearing - ctx.minAuctionBid) *
      Math.max(RECOMMENDED_BID_TUNING.late_squeeze_floor, squeeze)
  );
}

export function applyHitterMarketFloor(
  clearing: number,
  ctx: BidCtx
): number {
  if (
    isPitcherPosition(ctx.row.position) ||
    ctx.draftPhase === "late" ||
    ctx.depthFrac >= RECOMMENDED_BID_TUNING.hitter_floor.depth_cutoff
  ) {
    return clearing;
  }
  const hitterMarketFloor = Math.min(
    Math.max(
      ctx.a + RECOMMENDED_BID_TUNING.hitter_floor.adjusted_floor_add,
      ctx.r * RECOMMENDED_BID_TUNING.hitter_floor.baseline_weight
    ),
    ctx.a * RECOMMENDED_BID_TUNING.hitter_floor.adjusted_mult +
      RECOMMENDED_BID_TUNING.hitter_floor.adjusted_add
  );
  return Math.max(clearing, hitterMarketFloor);
}

export function applyHitterStarFloor(
  clearing: number,
  ctx: BidCtx
): number {
  if (
    isPitcherPosition(ctx.row.position) ||
    ctx.draftPhase === "late" ||
    ctx.depthFrac >= RECOMMENDED_BID_TUNING.hitter_star_floor.depth_cutoff
  ) {
    return clearing;
  }
  const starHitterFloor = Math.max(
    ctx.a + RECOMMENDED_BID_TUNING.hitter_star_floor.adjusted_add,
    ctx.r * RECOMMENDED_BID_TUNING.hitter_star_floor.baseline_weight
  );
  return Math.max(clearing, starHitterFloor);
}

export function applyGlobalDepthMinAdjusted(
  clearing: number,
  ctx: Pick<BidCtx, "depthFrac" | "a">
): number {
  if (ctx.depthFrac >= RECOMMENDED_BID_TUNING.global_depth_min_adjusted_mult.depth_cutoff) {
    return clearing;
  }
  return Math.max(
    clearing,
    ctx.a * RECOMMENDED_BID_TUNING.global_depth_min_adjusted_mult.mult
  );
}

export function applyLateHitterAnchorCap(
  clearing: number,
  ctx: BidCtx
): number {
  if (
    isPitcherPosition(ctx.row.position) ||
    ctx.draftPhase !== "late" ||
    ctx.depthFrac <= RECOMMENDED_BID_TUNING.late_hitter_anchor_cap.depth_min ||
    ctx.r <= RECOMMENDED_BID_TUNING.late_hitter_anchor_cap.baseline_min ||
    ctx.a <= 0 ||
    ctx.a >=
      ctx.r * RECOMMENDED_BID_TUNING.late_hitter_anchor_cap.adjusted_to_baseline_max_ratio
  ) {
    return clearing;
  }
  return Math.min(
    clearing,
    ctx.a +
      (ctx.r - ctx.a) * RECOMMENDED_BID_TUNING.late_hitter_anchor_cap.blend_weight
  );
}

export function applyPitcherHybridFloor(
  clearing: number,
  ctx: BidCtx
): number {
  if (
    !isPitcherPosition(ctx.row.position) ||
    ctx.draftPhase === "late" ||
    ctx.depthFrac >= RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.depth_cutoff ||
    ctx.r <= RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.baseline_min ||
    ctx.a <= 0 ||
    ctx.a >= RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.adjusted_max
  ) {
    return clearing;
  }
  return Math.max(
    clearing,
    Math.min(
      ctx.r * RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.baseline_weight,
      ctx.a * RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.adjusted_mult +
        RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.adjusted_add
    ),
    ctx.a + RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.absolute_floor_add
  );
}

export function applyEarlyNeutralPitcherCap(
  clearing: number,
  ctx: BidCtx
): number {
  if (
    !isPitcherPosition(ctx.row.position) ||
    ctx.draftPhase !== "early" ||
    !ctx.nearAuctionOpenNeutral ||
    ctx.a <= 0
  ) {
    return clearing;
  }
  const neutralCeil = Math.max(
    ctx.a + RECOMMENDED_BID_TUNING.early_neutral_pitcher_cap.adjusted_add,
    ctx.a * RECOMMENDED_BID_TUNING.early_neutral_pitcher_cap.adjusted_mult
  );
  return Math.min(clearing, neutralCeil);
}

export function applySoftHighCap(
  clearing: number,
  ctx: Pick<BidCtx, "a" | "r" | "minAuctionBid">
): number {
  const hiSoft =
    Math.max(ctx.r, ctx.a) * RECOMMENDED_BID_TUNING.hi_soft_cap.max_base_mult +
    RECOMMENDED_BID_TUNING.hi_soft_cap.add;
  return Math.max(ctx.minAuctionBid, Math.min(clearing, hiSoft));
}

export function buildBidContext(params: {
  row: ValuedPlayer;
  draftPhase: DraftPhaseIndicator;
  depthFrac: number;
  inflationIndexVsOpeningAuction: number | undefined;
  minAuctionBid: number;
}): BidCtx {
  const {
    row,
    draftPhase,
    depthFrac,
    inflationIndexVsOpeningAuction,
    minAuctionBid,
  } = params;
  const nearAuctionOpenNeutral =
    inflationIndexVsOpeningAuction != null &&
    Math.abs(inflationIndexVsOpeningAuction - 1) <=
      RECOMMENDED_BID_TUNING.early_neutral_pitcher_cap.index_delta_max;
  return {
    row,
    draftPhase,
    depthFrac,
    minAuctionBid,
    nearAuctionOpenNeutral,
    a: row.adjusted_value,
    r: row.baseline_value,
  };
}
