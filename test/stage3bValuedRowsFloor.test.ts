import { describe, expect, it } from "vitest";
import { applyTargetedSpSurplusFloors } from "../src/services/stage3bPitcherAllocation";

describe("Stage 3b SP surplus-dollar floors", () => {
  it("lifts marginal SP dollars and conserves surplus cash", () => {
    const dollars = new Map<string, number>([
      ["woo", 1.27],
      ["donor", 40],
    ]);
    const tiers = new Map<string, "depth" | "starter">([
      ["woo", "depth"],
      ["donor", "depth"],
    ]);
    const surplusCash = 41.27;
    applyTargetedSpSurplusFloors({
      dollarsByPlayerId: dollars,
      tierByPlayerId: tiers,
      surplusCash,
      draftablePlayerIds: ["woo", "donor"],
      surplusBasisById: new Map([
        ["woo", 11],
        ["donor", 8],
      ]),
      assignedSlotById: new Map([
        ["woo", "RP"],
        ["donor", "OF"],
      ]),
      tokensById: new Map([["woo", ["P", "SP"]]]),
      positionById: new Map([["woo", "P"]]),
      pitcherAuction: {
        enabled: true,
        minSurplusBasis: 5,
        spSurplusDollarPerSb: 0.72,
      },
    });
    expect(dollars.get("woo") ?? 0).toBeGreaterThanOrEqual(7.5);
    let sum = 0;
    for (const v of dollars.values()) sum += v;
    expect(Math.abs(sum - surplusCash)).toBeLessThan(0.05);
  });
});
