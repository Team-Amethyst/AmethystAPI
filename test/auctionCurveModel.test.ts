import { describe, expect, it } from "vitest";
import {
  buildTieredSurplusDollars,
  resolveAuctionCurveModel,
  TIERED_SURPLUS_V1,
} from "../src/services/auctionCurveModel";

describe("resolveAuctionCurveModel", () => {
  it("defaults to adaptive_surplus_v1", () => {
    expect(resolveAuctionCurveModel(undefined)).toBe("adaptive_surplus_v1");
    expect(resolveAuctionCurveModel("linear_v1")).toBe("linear_v1");
    expect(resolveAuctionCurveModel("bogus")).toBe("adaptive_surplus_v1");
  });

  it("accepts tiered_surplus_v1", () => {
    expect(resolveAuctionCurveModel("tiered_surplus_v1")).toBe("tiered_surplus_v1");
  });
});

describe("buildTieredSurplusDollars", () => {
  it("allocates surplus cash across tiers and conserves mass", () => {
    const surplusCash = 1000;
    const draftablePlayerIds = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const surplusBasisById = new Map(
      draftablePlayerIds.map((id, i) => [id, 100 - i])
    );
    const { dollarsByPlayerId, tierByPlayerId } = buildTieredSurplusDollars({
      surplusCash,
      draftablePlayerIds,
      surplusBasisById,
    });
    let sum = 0;
    for (const v of dollarsByPlayerId.values()) sum += v;
    expect(sum).toBeCloseTo(surplusCash, 4);
    expect(tierByPlayerId.get("a")).toBe("star");
    expect(tierByPlayerId.get("j")).toBe("depth");
    expect(dollarsByPlayerId.get("a")!).toBeGreaterThan(dollarsByPlayerId.get("j")!);
  });

  it("gives star tier more than starter at similar surplus_basis rank gap", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const surplusBasisById = new Map(ids.map((id, i) => [id, 50 - i * 0.1]));
    const { dollarsByPlayerId, tierByPlayerId } = buildTieredSurplusDollars({
      surplusCash: 500,
      draftablePlayerIds: ids,
      surplusBasisById,
    });
    const starId = ids[0]!;
    const starterId = ids[Math.ceil(ids.length * TIERED_SURPLUS_V1.starFraction)]!;
    expect(tierByPlayerId.get(starId)).toBe("star");
    expect(tierByPlayerId.get(starterId)).toBe("starter");
    expect(dollarsByPlayerId.get(starId)!).toBeGreaterThan(
      dollarsByPlayerId.get(starterId)!
    );
  });

  it("returns empty maps when surplus cash is zero", () => {
    const { dollarsByPlayerId } = buildTieredSurplusDollars({
      surplusCash: 0,
      draftablePlayerIds: ["x"],
      surplusBasisById: new Map([["x", 10]]),
    });
    expect(dollarsByPlayerId.size).toBe(0);
  });
});
