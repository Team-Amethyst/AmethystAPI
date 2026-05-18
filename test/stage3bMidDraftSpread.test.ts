import { describe, expect, it } from "vitest";
import { previewLinearSurplusAuction } from "../src/services/auctionCurveResolver";

describe("Stage 3b mid-draft inflation floor", () => {
  it("raises linear auction spread when inflation factor is lifted from 0.25 toward 0.33", () => {
    const ids = ["a", "b", "c"];
    const sb = new Map([
      ["a", 50],
      ["b", 45],
      ["c", 40],
    ]);
    const low = previewLinearSurplusAuction(ids, sb, 0.25, 1);
    const mid = previewLinearSurplusAuction(ids, sb, 0.33, 1);
    expect(mid.top1).toBeGreaterThan(low.top1);
    expect(mid.top25Spread).toBeGreaterThan(low.top25Spread);
  });
});
