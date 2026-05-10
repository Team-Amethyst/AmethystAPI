import { describe, expect, it } from "vitest";
import { playerTokensFromLean } from "../src/lib/fantasyRosterSlots";
import {
  aggregateNeedSlotUnits,
  positionalNeedMultiplier,
} from "../src/services/teamAdjustedNeed";
import type { LeanPlayer } from "../src/types/brain";

function player(partial: Partial<LeanPlayer> & Pick<LeanPlayer, "position">): LeanPlayer {
  return {
    _id: "x",
    mlbId: 1,
    name: "Test",
    team: "NYY",
    catalog_rank: 1,
    catalog_tier: 1,
    value: 20,
    ...partial,
  };
}

describe("positionalNeedMultiplier (primary + flex tiers)", () => {
  it("increases catcher need as open C primary seats increase", () => {
    const c = player({ position: "C" });
    const n0 = positionalNeedMultiplier(c, new Map([["C", 0]]));
    const n1 = positionalNeedMultiplier(c, new Map([["C", 1]]));
    const n2 = positionalNeedMultiplier(c, new Map([["C", 2]]));
    expect(n0).toBe(0.85);
    expect(n1).toBe(1.25);
    expect(n2).toBe(1.28);
    expect(n1).toBeLessThan(n2);
    expect(n0).toBeLessThan(n1);
  });

  it("primary open C > open CI/MI > open UTIL for eligible hitters", () => {
    const c = player({ position: "C" });
    const ss = player({ position: "SS" });
    const rf = player({ position: "RF" });
    const openC = positionalNeedMultiplier(c, new Map([["C", 1]]));
    const openMi = positionalNeedMultiplier(ss, new Map([["MI", 1]]));
    const openUtil = positionalNeedMultiplier(rf, new Map([["UTIL", 1]]));
    expect(openC).toBe(1.25);
    expect(openMi).toBeCloseTo(1.052, 3);
    expect(openUtil).toBeCloseTo(1.036, 3);
    expect(openMi).toBeGreaterThan(openUtil);
    expect(openC).toBeGreaterThan(openMi);
  });

  it("open MI boosts middle infield but not corner-only hitters", () => {
    const ss = player({ position: "SS" });
    const ob = player({ position: "1B" });
    const miOpen = new Map([["MI", 1]]);
    expect(positionalNeedMultiplier(ss, miOpen)).toBeCloseTo(1.052, 3);
    expect(positionalNeedMultiplier(ob, miOpen)).toBe(1.0);
    expect(positionalNeedMultiplier(ob, miOpen)).toBeLessThan(
      positionalNeedMultiplier(ss, miOpen)
    );
  });

  it("open CI boosts corners but not MI-only middle infield", () => {
    const ob = player({ position: "1B" });
    const ss = player({ position: "SS" });
    const ciOpen = new Map([["CI", 1]]);
    expect(positionalNeedMultiplier(ob, ciOpen)).toBeCloseTo(1.052, 3);
    expect(positionalNeedMultiplier(ss, ciOpen)).toBe(1.0);
    expect(positionalNeedMultiplier(ss, ciOpen)).toBeLessThan(
      positionalNeedMultiplier(ob, ciOpen)
    );
  });

  it("open UTIL gives mild hitter flex boost only", () => {
    const rf = player({ position: "RF" });
    const m = positionalNeedMultiplier(rf, new Map([["UTIL", 1]]));
    expect(m).toBeCloseTo(1.036, 3);
  });

  it("open SP primary boosts SP more than generic P flex", () => {
    const sp = player({ position: "SP" });
    const spPrimary = positionalNeedMultiplier(sp, new Map([["SP", 1]]));
    const pFlex = positionalNeedMultiplier(sp, new Map([["P", 1]]));
    expect(spPrimary).toBe(1.25);
    expect(pFlex).toBeCloseTo(1.044, 3);
    expect(spPrimary).toBeGreaterThan(pFlex);
  });

  it("open RP primary boosts RP more than generic P flex", () => {
    const rp = player({ position: "RP" });
    const rpPrimary = positionalNeedMultiplier(rp, new Map([["RP", 1]]));
    const pFlex = positionalNeedMultiplier(rp, new Map([["P", 1]]));
    expect(rpPrimary).toBe(1.25);
    expect(pFlex).toBeCloseTo(1.044, 3);
    expect(rpPrimary).toBeGreaterThan(pFlex);
  });

  it("generic P slot gives weaker pitcher flex than SP/RP primaries", () => {
    const sp = player({ position: "SP" });
    expect(positionalNeedMultiplier(sp, new Map([["P", 1]]))).toBeCloseTo(1.044, 3);
  });

  it("generic P applies the same flex boost to SP and RP (broader, tiered weak signal)", () => {
    const sp = player({ position: "SP" });
    const rp = player({ position: "RP" });
    const pOpen = new Map([["P", 1]]);
    expect(positionalNeedMultiplier(sp, pOpen)).toBeCloseTo(
      positionalNeedMultiplier(rp, pOpen),
      6
    );
  });

  it("bench rows do not affect need when skipped from aggregation", () => {
    const ss = player({ position: "SS" });
    const withBn = positionalNeedMultiplier(
      ss,
      new Map([
        ["SS", 1],
        ["BN", 12],
      ])
    );
    expect(withBn).toBe(1.25);
    const bnOnly = positionalNeedMultiplier(ss, new Map([["BN", 5]]));
    expect(bnOnly).toBe(1.0);
  });

  it("full SS (no open SS seat) lowers SS need versus one open SS seat", () => {
    const ss = player({ position: "SS" });
    const openOne = positionalNeedMultiplier(ss, new Map([["SS", 1]]));
    const full = positionalNeedMultiplier(ss, new Map([["SS", 0]]));
    expect(openOne).toBe(1.25);
    expect(full).toBe(0.85);
    expect(full).toBeLessThan(openOne);
  });

  it("differs for SP vs RP when matching primaries differ", () => {
    const spOnly = player({ position: "SP" });
    const rpOnly = player({ position: "RP" });

    const spStarved = positionalNeedMultiplier(
      spOnly,
      new Map([
        ["SP", 0],
        ["RP", 2],
      ])
    );
    const spFed = positionalNeedMultiplier(
      spOnly,
      new Map([
        ["SP", 2],
        ["RP", 0],
      ])
    );

    const rpStarved = positionalNeedMultiplier(
      rpOnly,
      new Map([
        ["SP", 2],
        ["RP", 0],
      ])
    );
    const rpFed = positionalNeedMultiplier(
      rpOnly,
      new Map([
        ["SP", 0],
        ["RP", 2],
      ])
    );

    expect(spFed).toBeGreaterThan(spStarved);
    expect(rpFed).toBeGreaterThan(rpStarved);
    expect(spFed).toBe(1.28);
    expect(rpFed).toBe(1.28);
    expect(spStarved).toBe(0.85);
    expect(rpStarved).toBe(0.85);
  });

  it("two MI flex seats can reach legacy ~1.10 flex cap", () => {
    const ss = player({ position: "SS" });
    const m = positionalNeedMultiplier(ss, new Map([["MI", 2]]));
    expect(m).toBe(1.1);
  });

  it("aggregateNeedSlotUnits splits CI/MI/UTIL/P vs primaries", () => {
    const p = player({ position: "SS" });
    const t = playerTokensFromLean(p);
    const agg = aggregateNeedSlotUnits(
      new Map([
        ["SS", 1],
        ["MI", 2],
        ["UTIL", 1],
      ]),
      t
    );
    expect(agg.primaryOpenUnits).toBe(1);
    expect(agg.flex.ciMiUnits).toBe(2);
    expect(agg.flex.utilUnits).toBe(1);
    expect(agg.flex.pUnits).toBe(0);
  });
});
