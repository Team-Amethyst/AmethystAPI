import { describe, expect, it } from "vitest";
import {
  eligibleAuctionSurplusSlots,
  maxSurplusOverSlots,
} from "../src/lib/fantasySlotAssignment";

const STANDARD_KEYS = new Set([
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "OF",
  "MI",
  "CI",
  "UTIL",
  "SP",
  "RP",
  "BN",
]);

describe("maxSurplusOverSlots auction surplus eligibility", () => {
  const repl = {
    C: 53,
    "1B": 51,
    "3B": 50,
    SS: 48,
    OF: 56,
    CI: 56,
    MI: 53,
    UTIL: 0,
    SP: 55,
    RP: 53,
    BN: 0,
  };

  it("hitter with 3B + UTIL uses 3B replacement, not UTIL@0", () => {
    const tokens = ["3B", "DH"];
    expect(eligibleAuctionSurplusSlots(tokens, STANDARD_KEYS)).toEqual(
      expect.arrayContaining(["3B"])
    );
    expect(eligibleAuctionSurplusSlots(tokens, STANDARD_KEYS)).not.toContain(
      "UTIL"
    );
    expect(maxSurplusOverSlots(55.58, tokens, repl, STANDARD_KEYS)).toBeCloseTo(
      5.58,
      2
    );
  });

  it("OF hitter uses OF replacement, not UTIL@0", () => {
    const tokens = ["OF", "DH"];
    expect(maxSurplusOverSlots(63.9, tokens, repl, STANDARD_KEYS)).toBeCloseTo(
      7.9,
      2
    );
  });

  it("pitcher uses SP/RP/P slots, never BN@0", () => {
    const tokens = ["P", "SP"];
    const slots = eligibleAuctionSurplusSlots(tokens, STANDARD_KEYS);
    expect(slots).not.toContain("BN");
    expect(slots).not.toContain("UTIL");
    expect(maxSurplusOverSlots(60.37, tokens, repl, STANDARD_KEYS)).toBeLessThan(
      10
    );
    expect(maxSurplusOverSlots(60.37, tokens, repl, STANDARD_KEYS)).toBeGreaterThan(
      0
    );
  });

  it("BN never appears in eligible auction surplus slots", () => {
    const tokens = ["1B"];
    expect(eligibleAuctionSurplusSlots(tokens, STANDARD_KEYS)).not.toContain("BN");
  });

  it("UTIL-only eligible path when no specific hitter slot fits", () => {
    const utilOnlyKeys = new Set(["UTIL", "BN"]);
    const tokens = ["OF"];
    expect(eligibleAuctionSurplusSlots(tokens, utilOnlyKeys)).toEqual(["UTIL"]);
    const replUtil = { UTIL: 52, BN: 0 };
    expect(maxSurplusOverSlots(60, tokens, replUtil, utilOnlyKeys)).toBe(8);
  });

  it("CI is ignored when 3B fits (no CI@0 artifact)", () => {
    const tokens = ["3B"];
    const replCiZero = { ...repl, CI: 0, "3B": 50 };
    expect(maxSurplusOverSlots(55.58, tokens, replCiZero, STANDARD_KEYS)).toBeCloseTo(
      5.58,
      2
    );
  });

  it("legacy MI/OF keys without UTIL still work", () => {
    const positionalKeys = new Set(["MI", "OF"]);
    const replLegacy = { MI: 4, OF: 3 };
    expect(maxSurplusOverSlots(25, ["OF"], replLegacy, positionalKeys)).toBe(22);
  });
});
