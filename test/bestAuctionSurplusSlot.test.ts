import { describe, expect, it } from "vitest";
import { bestAuctionSurplusSlot } from "../src/lib/fantasySlotAssignment";

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

describe("bestAuctionSurplusSlot", () => {
  const repl = {
    C: 53,
    "1B": 51,
    "3B": 50,
    SS: 48,
    OF: 56,
    UTIL: 0,
    SP: 55,
    RP: 53,
    BN: 0,
  };

  it("picks 3B over UTIL@0 for a 3B-eligible hitter", () => {
    const best = bestAuctionSurplusSlot(55.58, ["3B"], repl, STANDARD_KEYS);
    expect(best?.slot).toBe("3B");
    expect(best?.replacement).toBeCloseTo(50, 0);
    expect(best?.surplus).toBeCloseTo(5.58, 1);
  });

  it("never returns BN", () => {
    const best = bestAuctionSurplusSlot(60, ["1B"], repl, STANDARD_KEYS);
    expect(best?.slot).not.toBe("BN");
  });
});
