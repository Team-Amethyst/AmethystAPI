import type { DraftPhaseIndicator, ValuedPlayer } from "../types/brain";
import {
  applyEarlyEliteAnchorBoost,
  applyEarlyNeutralPitcherCap,
  applyGlobalDepthMinAdjusted,
  applyHitterMarketFloor,
  applyHitterStarFloor,
  applyLateHitterAnchorCap,
  applyLateSqueeze,
  applyPitcherHybridFloor,
  applySoftHighCap,
  buildBidContext,
  buildLambdaForRow,
  initialClearingPrice,
} from "./recommendedBidSteps";
import { isPitcherPosition, isotonicNonIncreasing } from "./recommendedBidMath";

export { RECOMMENDED_BID_TUNING } from "./recommendedBidConfig";
export { baseLambdaClearingPrice, isPitcherPosition } from "./recommendedBidMath";

export function computeRecommendedBid(params: {
  row: ValuedPlayer;
  draftPhase: DraftPhaseIndicator;
  depthFrac: number;
  inflationIndexVsOpeningAuction: number | undefined;
  minAuctionBid: number;
}): number {
  const ctx = buildBidContext(params);
  const L = buildLambdaForRow(ctx.row, ctx.draftPhase, ctx.depthFrac);
  let clearing = initialClearingPrice(L, ctx.a, ctx.r);
  clearing = applyEarlyEliteAnchorBoost(clearing, ctx);
  clearing = applyLateSqueeze(clearing, ctx);
  clearing = applyHitterMarketFloor(clearing, ctx);
  clearing = applyHitterStarFloor(clearing, ctx);
  clearing = applyGlobalDepthMinAdjusted(clearing, ctx);
  clearing = applyLateHitterAnchorCap(clearing, ctx);
  clearing = applyPitcherHybridFloor(clearing, ctx);
  clearing = applyEarlyNeutralPitcherCap(clearing, ctx);
  return applySoftHighCap(clearing, ctx);
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
