import type { DraftPhaseIndicator, ValuedPlayer } from "../types/brain";
import { RECOMMENDED_BID_TUNING } from "./recommendedBidConfig";
import {
  baseLambdaClearingPrice,
  isPitcherPosition,
  isotonicNonIncreasing,
} from "./recommendedBidMath";

export { RECOMMENDED_BID_TUNING } from "./recommendedBidConfig";
export { baseLambdaClearingPrice, isPitcherPosition } from "./recommendedBidMath";

export function computeRecommendedBid(params: {
  row: ValuedPlayer;
  draftPhase: DraftPhaseIndicator;
  depthFrac: number;
  inflationIndexVsOpeningAuction: number | undefined;
  minAuctionBid: number;
}): number {
  const {
    row,
    draftPhase,
    depthFrac,
    inflationIndexVsOpeningAuction,
    minAuctionBid,
  } = params;
  const a = row.adjusted_value;
  const r = row.baseline_value;
  const nearAuctionOpenNeutral =
    inflationIndexVsOpeningAuction != null &&
    Math.abs(inflationIndexVsOpeningAuction - 1) <=
      RECOMMENDED_BID_TUNING.early_neutral_pitcher_cap.index_delta_max;
  let L = baseLambdaClearingPrice(draftPhase, depthFrac);
  if (isPitcherPosition(row.position)) {
    const damp =
      draftPhase === "early"
        ? RECOMMENDED_BID_TUNING.pitcher_lambda_damp.early
        : draftPhase === "mid"
          ? RECOMMENDED_BID_TUNING.pitcher_lambda_damp.mid
          : RECOMMENDED_BID_TUNING.pitcher_lambda_damp.late;
    L *= damp;
  }
  let clearing = a + L * (r - a);
  if (draftPhase === "early" && depthFrac < 0.06) {
    clearing += RECOMMENDED_BID_TUNING.early_elite_anchor_boost * (r - a);
  }
  if (draftPhase === "late") {
    const squeeze = 0.5 + 0.5 * (1 - depthFrac);
    clearing =
      minAuctionBid +
      (clearing - minAuctionBid) *
        Math.max(RECOMMENDED_BID_TUNING.late_squeeze_floor, squeeze);
  }
  if (
    !isPitcherPosition(row.position) &&
    draftPhase !== "late" &&
    depthFrac < RECOMMENDED_BID_TUNING.hitter_floor.depth_cutoff
  ) {
    const hitterMarketFloor = Math.min(
      Math.max(
        a + RECOMMENDED_BID_TUNING.hitter_floor.adjusted_floor_add,
        r * RECOMMENDED_BID_TUNING.hitter_floor.baseline_weight
      ),
      a * RECOMMENDED_BID_TUNING.hitter_floor.adjusted_mult +
        RECOMMENDED_BID_TUNING.hitter_floor.adjusted_add
    );
    clearing = Math.max(clearing, hitterMarketFloor);
  }
  if (
    !isPitcherPosition(row.position) &&
    draftPhase !== "late" &&
    depthFrac < RECOMMENDED_BID_TUNING.hitter_star_floor.depth_cutoff
  ) {
    const starHitterFloor = Math.max(
      a + RECOMMENDED_BID_TUNING.hitter_star_floor.adjusted_add,
      r * RECOMMENDED_BID_TUNING.hitter_star_floor.baseline_weight
    );
    clearing = Math.max(clearing, starHitterFloor);
  }
  if (depthFrac < RECOMMENDED_BID_TUNING.global_depth_min_adjusted_mult.depth_cutoff) {
    clearing = Math.max(
      clearing,
      a * RECOMMENDED_BID_TUNING.global_depth_min_adjusted_mult.mult
    );
  }
  if (
    !isPitcherPosition(row.position) &&
    draftPhase === "late" &&
    depthFrac > RECOMMENDED_BID_TUNING.late_hitter_anchor_cap.depth_min &&
    r > RECOMMENDED_BID_TUNING.late_hitter_anchor_cap.baseline_min &&
    a > 0 &&
    a <
      r * RECOMMENDED_BID_TUNING.late_hitter_anchor_cap.adjusted_to_baseline_max_ratio
  ) {
    clearing = Math.min(
      clearing,
      a + (r - a) * RECOMMENDED_BID_TUNING.late_hitter_anchor_cap.blend_weight
    );
  }
  if (
    isPitcherPosition(row.position) &&
    draftPhase !== "late" &&
    depthFrac < RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.depth_cutoff &&
    r > RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.baseline_min &&
    a > 0 &&
    a < RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.adjusted_max
  ) {
    clearing = Math.max(
      clearing,
      Math.min(
        r * RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.baseline_weight,
        a * RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.adjusted_mult +
          RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.adjusted_add
      ),
      a + RECOMMENDED_BID_TUNING.pitcher_hybrid_floor.absolute_floor_add
    );
  }
  if (
    isPitcherPosition(row.position) &&
    draftPhase === "early" &&
    nearAuctionOpenNeutral &&
    a > 0
  ) {
    const neutralCeil = Math.max(
      a + RECOMMENDED_BID_TUNING.early_neutral_pitcher_cap.adjusted_add,
      a * RECOMMENDED_BID_TUNING.early_neutral_pitcher_cap.adjusted_mult
    );
    clearing = Math.min(clearing, neutralCeil);
  }
  const hiSoft =
    Math.max(r, a) * RECOMMENDED_BID_TUNING.hi_soft_cap.max_base_mult +
    RECOMMENDED_BID_TUNING.hi_soft_cap.add;
  return Math.max(minAuctionBid, Math.min(clearing, hiSoft));
}

export function smoothRecommendedBids(
  valuations: ValuedPlayer[],
  minAuctionBid: number
): void {
  const smoothGroup = (rows: ValuedPlayer[]) => {
    const ordDesc = [...rows].sort((a, b) => b.baseline_value - a.baseline_value);
    const recSeries = ordDesc.map((r) => r.recommended_bid ?? minAuctionBid);
    const smoothed = isotonicNonIncreasing(recSeries);
    for (let k = 0; k < ordDesc.length; k++) {
      ordDesc[k].recommended_bid = parseFloat(
        Math.max(minAuctionBid, smoothed[k] ?? minAuctionBid).toFixed(2)
      );
    }
  };
  smoothGroup(valuations.filter((r) => !isPitcherPosition(r.position)));
  smoothGroup(valuations.filter((r) => isPitcherPosition(r.position)));
}
