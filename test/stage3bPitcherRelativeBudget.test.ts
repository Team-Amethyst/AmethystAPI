import { describe, expect, it } from "vitest";
import { buildTieredSurplusDollars } from "../src/services/auctionCurveModel";
import { buildBucketTieredSurplusDollars } from "../src/services/stage3bPitcherAllocation";

describe("Stage 3b pitcher-relative budget", () => {
  it("allocates more surplus dollars to mid-tier SP than global depth tier", () => {
    const surplusBasisById = new Map([
      ["of1", 48],
      ["of2", 46],
      ["sp_star", 50],
      ["sp_mid", 11],
    ]);
    const assignedSlotById = new Map([
      ["of1", "OF"],
      ["of2", "OF"],
      ["sp_star", "SP"],
      ["sp_mid", "SP"],
    ]);
    const global = buildTieredSurplusDollars({
      surplusCash: 200,
      draftablePlayerIds: ["of1", "of2", "sp_star", "sp_mid"],
      surplusBasisById,
      assignedSlotById,
    });
    const bucketed = buildBucketTieredSurplusDollars({
      surplusCash: 200,
      draftablePlayerIds: ["of1", "of2", "sp_star", "sp_mid"],
      surplusBasisById,
      assignedSlotById,
      pitcherRelative: {
        enabled: true,
        pitcherSurplusShare: 0.27,
        pitcherStarFraction: 0.5,
        pitcherStarterFraction: 0.5,
      },
    });
    expect(bucketed.dollarsByPlayerId.get("sp_mid") ?? 0).toBeGreaterThan(
      global.dollarsByPlayerId.get("sp_mid") ?? 0,
    );
  });
});
