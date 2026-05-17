import { describe, expect, it } from "vitest";
import {
  applyHybridDraftableSurplusBasis,
} from "../src/services/replacementSlotsV2Helpers";
import {
  DEFAULT_HYBRID_SURPLUS_CALIBRATION,
  STAGE1_HYBRID_SURPLUS_CALIBRATION,
} from "../src/services/replacementSlotsV2Config";
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
      calibration: { ...STAGE1_HYBRID_SURPLUS_CALIBRATION, eliteGateMin: 60 },
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

describe("position-aware scarce-slot calibration", () => {
  it("lifts 3B elite with strong category projection but not OF peer at same baseline", () => {
    const assigned = new Set(["of_star", "third"]);
    const surplusBasisById = new Map([
      ["of_star", 5],
      ["third", 4],
    ]);
    const baselineById = new Map([
      ["of_star", 58],
      ["third", 58],
    ]);
    const categoryProjectionById = new Map([
      ["of_star", 42],
      ["third", 42],
    ]);
    const assignedSlotById = new Map([
      ["of_star", "OF"],
      ["third", "3B"],
    ]);
    const out = applyHybridDraftableSurplusBasis({
      surplusBasisById,
      assignedIds: assigned,
      baselineById,
      targetTotalMass: 9,
      strengthFloorBaselines: [40, 45, 50, 55, 58],
      playerTokensById: new Map([
        ["of_star", ["OF"]],
        ["third", ["3B"]],
      ]),
      categoryProjectionById,
      assignedSlotById,
      calibration: DEFAULT_HYBRID_SURPLUS_CALIBRATION,
    });
    expect(out.surplusBasisById.get("of_star")).toBe(5);
    expect(out.surplusBasisById.get("third") ?? 0).toBeGreaterThan(20);
    expect(out.hybridLiftByPlayerId.get("third") ?? 0).toBeGreaterThan(0);
  });

  it("does not lift scarce-slot hitter below minCategoryProjection", () => {
    const assigned = new Set(["weak"]);
    const out = applyHybridDraftableSurplusBasis({
      surplusBasisById: new Map([["weak", 3]]),
      assignedIds: assigned,
      baselineById: new Map([["weak", 58]]),
      targetTotalMass: 3,
      strengthFloorBaselines: [50, 55, 58],
      playerTokensById: new Map([["weak", ["SS"]]]),
      categoryProjectionById: new Map([["weak", 35]]),
      assignedSlotById: new Map([["weak", "SS"]]),
      calibration: DEFAULT_HYBRID_SURPLUS_CALIBRATION,
    });
    expect(out.surplusBasisById.get("weak")).toBe(3);
    expect(out.hybridLiftByPlayerId.size).toBe(0);
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
