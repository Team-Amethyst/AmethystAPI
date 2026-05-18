import { describe, expect, it } from "vitest";
import { buildTieredSurplusDollars } from "../src/services/auctionCurveModel";

describe("buildTieredSurplusDollars hybrid auction tier", () => {
  it("promotes hybrid-lifted starter to star auction weight", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const sb = new Map(ids.map((id, i) => [id, 55 - i * 0.8]));
    const target = "p14";
    sb.set(target, 39);
    const hybrid = new Map([[target, 12]]);
    const { tierByPlayerId, dollarsByPlayerId } = buildTieredSurplusDollars({
      surplusCash: 500,
      draftablePlayerIds: ids,
      surplusBasisById: sb,
      hybridLiftById: hybrid,
    });
    expect(tierByPlayerId.get(target)).toBe("star");
    expect((dollarsByPlayerId.get(target) ?? 0) + 1).toBeGreaterThan(
      (dollarsByPlayerId.get("p18") ?? 0) * 2,
    );
  });
});
