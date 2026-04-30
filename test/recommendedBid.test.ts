import { describe, expect, it } from "vitest";
import {
  computeRecommendedBid,
  isPitcherPosition,
  smoothRecommendedBids,
} from "../src/services/recommendedBid";
import type { ValuedPlayer } from "../src/types/brain";

function mkRow(over: Partial<ValuedPlayer> = {}): ValuedPlayer {
  return {
    player_id: "p1",
    name: "Player",
    position: "SP",
    team: "NYY",
    adp: 25,
    tier: 1,
    baseline_value: 68,
    adjusted_value: 27,
    indicator: "Fair Value",
    inflation_factor: 1,
    ...over,
  };
}

describe("recommendedBid helpers", () => {
  it("detects pitcher positions", () => {
    expect(isPitcherPosition("SP")).toBe(true);
    expect(isPitcherPosition("RP")).toBe(true);
    expect(isPitcherPosition("P")).toBe(true);
    expect(isPitcherPosition("OF")).toBe(false);
  });

  it("caps early neutral pitcher bids near adjusted value", () => {
    const row = mkRow({ position: "SP", adjusted_value: 27, baseline_value: 68 });
    const bid = computeRecommendedBid({
      row,
      draftPhase: "early",
      depthFrac: 0.2,
      inflationIndexVsOpeningAuction: 1.0,
      minAuctionBid: 1,
    });
    const cap = Math.max(row.adjusted_value + 5, row.adjusted_value * 1.45);
    expect(bid).toBeLessThanOrEqual(cap + 0.01);
  });

  it("keeps smoothed series non-increasing within group", () => {
    const rows: ValuedPlayer[] = [
      mkRow({ player_id: "a", baseline_value: 50, recommended_bid: 10 }),
      mkRow({ player_id: "b", baseline_value: 40, recommended_bid: 20 }),
      mkRow({ player_id: "c", baseline_value: 30, recommended_bid: 15 }),
    ];
    smoothRecommendedBids(rows, 1);
    const byBase = [...rows].sort((a, b) => b.baseline_value - a.baseline_value);
    for (let i = 1; i < byBase.length; i++) {
      expect(byBase[i - 1]!.recommended_bid!).toBeGreaterThanOrEqual(
        byBase[i]!.recommended_bid!
      );
    }
  });
});
