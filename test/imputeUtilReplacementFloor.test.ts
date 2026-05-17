import { describe, expect, it } from "vitest";
import { imputeUtilReplacementFloor } from "../src/services/replacementSlotsV2Helpers";

const STANDARD_KEYS = new Set([
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "OF",
  "UTIL",
  "SP",
  "RP",
  "BN",
]);

describe("imputeUtilReplacementFloor", () => {
  it("floors UTIL at max hitter replacement when greedy left UTIL at 0", () => {
    const repl = {
      C: 51,
      "1B": 52,
      "3B": 50,
      OF: 56,
      UTIL: 0,
      SP: 54,
      BN: 0,
    };
    const out = imputeUtilReplacementFloor(repl, STANDARD_KEYS);
    expect(out.UTIL).toBe(56);
  });

  it("does not lower a positive UTIL", () => {
    const repl = { OF: 56, UTIL: 58, BN: 0 };
    const out = imputeUtilReplacementFloor(repl, STANDARD_KEYS);
    expect(out.UTIL).toBe(58);
  });
});
