import { describe, expect, it } from "vitest";
import { buildConvexSurplusDollars } from "../src/services/replacementSlotsV2Helpers";

describe("buildConvexSurplusDollars", () => {
  it("allocates more surplus to higher surplus×baseline players", () => {
    const sb = new Map([
      ["elite", 60],
      ["mid", 35],
      ["low", 12],
    ]);
    const baseline = new Map([
      ["elite", 62],
      ["mid", 38],
      ["low", 15],
    ]);
    const dollars = buildConvexSurplusDollars({
      surplusCash: 100,
      draftablePlayerIds: ["elite", "mid", "low"],
      surplusBasisById: sb,
      baselineById: baseline,
      exponent: 1.2,
    });
    expect(dollars.get("elite")!).toBeGreaterThan(dollars.get("mid")!);
    expect(dollars.get("mid")!).toBeGreaterThan(dollars.get("low")!);
    const sum = [...dollars.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(100, 1);
  });
});
