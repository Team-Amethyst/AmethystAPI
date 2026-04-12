import { describe, expect, it } from "vitest";
import {
  assignTier,
  calcAge,
  calcBatterValue,
  calcPitcherValue,
} from "../src/lib/mlbSyncFormulas";

describe("mlbSyncFormulas", () => {
  it("calcAge from birthDate", () => {
    expect(calcAge(undefined)).toBe(0);
    const y = new Date().getFullYear() - 30;
    expect(calcAge(`${y}-06-15`)).toBeGreaterThanOrEqual(29);
  });

  it("assignTier buckets", () => {
    expect(assignTier(50)).toBe(1);
    expect(assignTier(30)).toBe(2);
    expect(assignTier(18)).toBe(3);
    expect(assignTier(8)).toBe(4);
    expect(assignTier(2)).toBe(5);
  });

  it("calcBatterValue returns 0 when atBats below threshold", () => {
    expect(
      calcBatterValue({
        homeRuns: 40,
        rbi: 100,
        runs: 100,
        stolenBases: 20,
        avg: ".300",
        atBats: 50,
      })
    ).toBe(0);
  });

  it("calcBatterValue is positive for full-season shape (MLB stat keys)", () => {
    const v = calcBatterValue({
      homeRuns: 35,
      rbi: 95,
      runs: 100,
      stolenBases: 15,
      avg: ".285",
      atBats: 550,
    });
    expect(v).toBeGreaterThan(0);
  });

  it("calcPitcherValue returns 0 for low IP and saves", () => {
    expect(
      calcPitcherValue({
        era: "3.50",
        whip: "1.10",
        strikeOuts: 80,
        wins: 5,
        saves: 0,
        inningsPitched: "10.0",
      })
    ).toBe(0);
  });

  it("calcPitcherValue is positive for starter workload", () => {
    const v = calcPitcherValue({
      era: "3.20",
      whip: "1.05",
      strikeOuts: 200,
      wins: 12,
      saves: 0,
      inningsPitched: "180.0",
    });
    expect(v).toBeGreaterThan(0);
  });
});
