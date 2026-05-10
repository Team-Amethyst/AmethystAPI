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

/**
 * Optional trust mode: clamp each `recommended_bid` to at most `ratio × auction_value`
 * after isotonic smoothing. Does not change `auction_value` / `adjusted_value`.
 */
export function applyRecommendedBidSoftCap(
  valuations: ValuedPlayer[],
  ratio: number,
  minAuctionBid: number
): void {
  if (!Number.isFinite(ratio) || ratio < 1) return;
  for (const row of valuations) {
    const av = row.auction_value;
    const rb = row.recommended_bid ?? minAuctionBid;
    if (!Number.isFinite(av) || av <= 0) continue;
    const cap = Math.max(minAuctionBid, av * ratio);
    if (rb > cap) {
      row.recommended_bid = parseFloat(cap.toFixed(2));
    }
  }
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
