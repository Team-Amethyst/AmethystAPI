import { describe, expect, it } from "vitest";
import { buildTieredSurplusDollars } from "../src/services/auctionCurveModel";

describe("Stage 3b pitcher auction weight", () => {
  it("boosts draftable SP surplus dollars without changing hitter weights", () => {
    const surplusBasisById = new Map([
      ["sp1", 12],
      ["of1", 48],
    ]);
    const assignedSlotById = new Map([
      ["sp1", "SP"],
      ["of1", "OF"],
    ]);
    const base = buildTieredSurplusDollars({
      surplusCash: 100,
      draftablePlayerIds: ["sp1", "of1"],
      surplusBasisById,
      assignedSlotById,
    });
    const boosted = buildTieredSurplusDollars({
      surplusCash: 100,
      draftablePlayerIds: ["sp1", "of1"],
      surplusBasisById,
      assignedSlotById,
      pitcherAuction: {
        enabled: true,
        minSurplusBasis: 5,
        spWeightMult: 1.4,
        promoteStarterMinSurplus: 10,
      },
    });
    const spBase = base.dollarsByPlayerId.get("sp1") ?? 0;
    const spBoost = boosted.dollarsByPlayerId.get("sp1") ?? 0;
    expect(spBoost).toBeGreaterThan(spBase);
    expect(spBoost / Math.max(spBase, 0.01)).toBeGreaterThan(1.15);
  });
});
