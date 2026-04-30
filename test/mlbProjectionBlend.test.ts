import { describe, expect, it } from "vitest";
import { projectBatting, projectPitching } from "../src/lib/mlbProjectionBlend";

describe("mlbProjectionBlend", () => {
  it("weights recent season more in batting blend", () => {
    const y1 = { atBats: 500, hits: 150, homeRuns: 30, rbi: 90, runs: 85, stolenBases: 10 };
    const y2 = { atBats: 480, hits: 130, homeRuns: 20, rbi: 70, runs: 75, stolenBases: 8 };
    const y3 = { atBats: 400, hits: 100, homeRuns: 12, rbi: 50, runs: 55, stolenBases: 5 };
    const out = projectBatting(y1, y2, y3);
    expect(out).not.toBeNull();
    expect(out!.hr).toBeGreaterThan(20);
    expect(out!.hr).toBeLessThan(30);
  });

  it("returns null when no year meets minimum AB", () => {
    expect(projectBatting({ atBats: 10, hits: 2 }, null, null)).toBeNull();
  });

  it("blends pitching ERA from weighted ER/IP", () => {
    const y1 = { inningsPitched: 180, earnedRuns: 54, hits: 150, baseOnBalls: 50, wins: 12, saves: 0, strikeOuts: 200 };
    const y2 = { inningsPitched: 170, earnedRuns: 68, hits: 160, baseOnBalls: 55, wins: 10, saves: 0, strikeOuts: 180 };
    const out = projectPitching(y1, y2, null);
    expect(out).not.toBeNull();
    expect(parseFloat(out!.era)).toBeGreaterThan(2.5);
    expect(parseFloat(out!.era)).toBeLessThan(4.5);
  });
});
