import { describe, expect, it } from "vitest";
import {
  estimateQualityStartsFromSeasonAggregate,
  projectBatting,
  projectPitching,
} from "../src/lib/mlbProjectionBlend";

describe("mlbProjectionBlend extended stat outputs", () => {
  const batY1 = {
    atBats: 500,
    hits: 140,
    homeRuns: 25,
    rbi: 80,
    runs: 85,
    stolenBases: 10,
    plateAppearances: 550,
    obp: ".360",
    totalBases: 250,
    ops: ".850",
    slg: ".490",
  };
  const pitY1 = {
    inningsPitched: 170,
    saves: 3,
    wins: 12,
    strikeOuts: 190,
    earnedRuns: 55,
    hits: 140,
    baseOnBalls: 45,
    holds: 8,
    qualityStarts: 18,
  };

  it("projectBatting emits slg, ops, totalBases", () => {
    const b = projectBatting(batY1, null, null, 10);
    expect(b).not.toBeNull();
    if (!b) return;
    expect(b.totalBases).toBeGreaterThan(0);
    expect(parseFloat(b.slg)).toBeGreaterThan(0);
    expect(parseFloat(b.ops)).toBeGreaterThan(0);
  });

  it("projectPitching emits holds and qualityStarts", () => {
    const p = projectPitching(pitY1, null, null, 10, 2);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.holds).toBeGreaterThanOrEqual(0);
    expect(p.qualityStarts).toBeGreaterThanOrEqual(0);
  });

  it("estimateQualityStartsFromSeasonAggregate fills when API omits qualityStarts", () => {
    const est = estimateQualityStartsFromSeasonAggregate({
      gamesStarted: 32,
      inningsPitched: 198,
      earnedRuns: 78,
    });
    expect(est).toBeGreaterThan(5);
    expect(est).toBeLessThanOrEqual(32);
  });

  it("estimateQualityStarts prefers API qualityStarts when present", () => {
    expect(
      estimateQualityStartsFromSeasonAggregate({
        qualityStarts: 22,
        gamesStarted: 30,
        inningsPitched: 180,
        earnedRuns: 70,
      })
    ).toBe(22);
  });
});

describe("mlbProjectionBlend", () => {
  it("weights recent season more in batting blend", () => {
    const y1 = {
      atBats: 500,
      hits: 150,
      homeRuns: 30,
      rbi: 90,
      runs: 85,
      stolenBases: 10,
      totalBases: 280,
    };
    const y2 = {
      atBats: 480,
      hits: 130,
      homeRuns: 20,
      rbi: 70,
      runs: 75,
      stolenBases: 8,
      totalBases: 220,
    };
    const y3 = {
      atBats: 400,
      hits: 100,
      homeRuns: 12,
      rbi: 50,
      runs: 55,
      stolenBases: 5,
      totalBases: 150,
    };
    const out = projectBatting(y1, y2, y3);
    expect(out).not.toBeNull();
    expect(out!.hr).toBeGreaterThan(20);
    expect(out!.hr).toBeLessThan(30);
    expect(out!.atBats).toBeGreaterThan(400);
    expect(out!.plateAppearances).toBeGreaterThan(400);
    expect(out!.totalBases).toBeGreaterThan(0);
  });

  it("returns null when no year meets minimum AB", () => {
    expect(projectBatting({ atBats: 10, hits: 2 }, null, null)).toBeNull();
  });

  it("blends pitching ERA from weighted ER/IP", () => {
    const y1 = {
      inningsPitched: 180,
      earnedRuns: 54,
      hits: 150,
      baseOnBalls: 50,
      wins: 12,
      saves: 0,
      strikeOuts: 200,
    };
    const y2 = {
      inningsPitched: 170,
      earnedRuns: 68,
      hits: 160,
      baseOnBalls: 55,
      wins: 10,
      saves: 0,
      strikeOuts: 180,
    };
    const out = projectPitching(y1, y2, null);
    expect(out).not.toBeNull();
    expect(parseFloat(out!.era)).toBeGreaterThan(2.5);
    expect(parseFloat(out!.era)).toBeLessThan(4.5);
  });
});
