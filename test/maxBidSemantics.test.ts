import { describe, expect, it } from "vitest";
import { computeMaxBidDollars } from "../src/services/maxBid";
import type { ValuedPlayer } from "../src/types/brain";

function baseRow(over: Partial<ValuedPlayer>): ValuedPlayer {
  return {
    player_id: "x",
    name: "X",
    position: "OF",
    team: "NYY",
    catalog_rank: 1,
    catalog_tier: 1,
    baseline_rank: 1,
    auction_rank: 1,
    baseline_tier: 2,
    auction_tier: 2,
    baseline_value: 40,
    auction_value: 28,
    adjusted_value: 28,
    indicator: "Fair Value",
    inflation_factor: 1,
    ...over,
  } as ValuedPlayer;
}

const mAsymmetric = {
  need: 1.18,
  budget: 0.92,
  dollars_per_slot: 1.08,
  slot_scarcity: 1.06,
  replacement_dropoff: 1.09,
} as const;

describe("computeMaxBidDollars", () => {
  it("uses team marginal base (same inputs as team_adjusted path): higher base ⇒ higher max at same auction FMV", () => {
    const row = baseRow({});
    const low = computeMaxBidDollars({
      row,
      base: 22,
      adjustedValue: 28,
      minAuctionBid: 1,
      multipliers: mAsymmetric,
      symmetricOpen: false,
      openSeatFraction: 0.9,
    });
    const high = computeMaxBidDollars({
      row,
      base: 38,
      adjustedValue: 28,
      minAuctionBid: 1,
      multipliers: mAsymmetric,
      symmetricOpen: false,
      openSeatFraction: 0.9,
    });
    expect(high).toBeGreaterThan(low);
  });

  it("symmetric path stays within headroom of adjusted_value even with huge baseline_value", () => {
    const row = baseRow({
      baseline_value: 120,
      baseline_tier: 1,
      adjusted_value: 18,
      auction_value: 18,
    });
    const mb = computeMaxBidDollars({
      row,
      base: 18,
      adjustedValue: 18,
      minAuctionBid: 1,
      multipliers: {
        need: 1,
        budget: 1,
        dollars_per_slot: 1,
        slot_scarcity: 1,
        replacement_dropoff: 1,
      },
      symmetricOpen: true,
      openSeatFraction: 1,
    });
    expect(mb).toBeLessThanOrEqual(18 * 1.12 + 0.02);
    expect(mb).toBeGreaterThanOrEqual(18);
  });

  it("does not chase a hypothetical hot market-anchor dollar when list ≫ FMV (anti–runaway-by-baseline)", () => {
    const row = baseRow({
      baseline_value: 95,
      baseline_tier: 1,
      adjusted_value: 24,
      auction_value: 24,
    });
    const mb = computeMaxBidDollars({
      row,
      base: 24,
      adjustedValue: 24,
      minAuctionBid: 1,
      multipliers: {
        need: 1,
        budget: 1,
        dollars_per_slot: 1,
        slot_scarcity: 1,
        replacement_dropoff: 1,
      },
      symmetricOpen: true,
      openSeatFraction: 1,
    });
    const hypotheticalHotAnchor = 55;
    expect(mb).toBeLessThan(hypotheticalHotAnchor);
    expect(mb).toBeLessThanOrEqual(24 * 1.12);
  });
});
