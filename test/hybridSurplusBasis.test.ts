import { describe, expect, it } from "vitest";
import {
  applyHybridDraftableSurplusBasis,
} from "../src/services/replacementSlotsV2Helpers";
import { maxSurplusOverSlots } from "../src/lib/fantasyRosterSlots";

describe("applyHybridDraftableSurplusBasis", () => {
  it("lifts low slot-surplus elite hitters without changing high slot-surplus rows", () => {
    const assigned = new Set(["a", "b", "c"]);
    const surplusBasisById = new Map([
      ["a", 50],
      ["b", 3],
      ["c", 4],
    ]);
    const baselineById = new Map([
      ["a", 64],
      ["b", 61],
      ["c", 55],
    ]);
    const out = applyHybridDraftableSurplusBasis({
      surplusBasisById,
      assignedIds: assigned,
      baselineById,
      targetTotalMass: 57,
      strengthFloorBaselines: [30, 40, 50, 55, 60, 61, 64],
      playerTokensById: new Map([
        ["a", ["OF"]],
        ["b", ["SS"]],
        ["c", ["3B"]],
      ]),
      calibration: { eliteGateMin: 60, hybridCap: 46, strengthMultiplier: 2.15 },
    });
    expect(out.surplusBasisById.get("a")).toBe(50);
    expect(out.surplusBasisById.get("b") ?? 0).toBeGreaterThan(30);
    expect(out.surplusBasisById.get("c")).toBe(4);
  });

  it("does not change non-assigned map entries", () => {
    const assigned = new Set(["a"]);
    const surplusBasisById = new Map([
      ["a", 10],
      ["fringe", 8],
    ]);
    const out = applyHybridDraftableSurplusBasis({
      surplusBasisById,
      assignedIds: assigned,
      baselineById: new Map([["a", 60]]),
      targetTotalMass: 10,
      calibration: { eliteGateMin: 58, hybridCap: 46, strengthMultiplier: 2.15 },
    });
    expect(out.surplusBasisById.get("fringe")).toBe(8);
  });
});

describe("UTIL/BN exclusion unchanged with hybrid path", () => {
  it("maxSurplusOverSlots still ignores UTIL@0 and BN@0", () => {
    const repl = { OF: 40, UTIL: 0, BN: 0, SS: 45 };
    const keys = new Set(Object.keys(repl));
    expect(maxSurplusOverSlots(55, ["SS", "OF"], repl, keys)).toBe(15);
    expect(maxSurplusOverSlots(55, ["SS", "OF"], repl, keys)).not.toBe(55);
  });
});
