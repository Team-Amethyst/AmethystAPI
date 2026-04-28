import { describe, expect, it } from "vitest";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import type { LeanPlayer } from "../src/types/brain";

const players: LeanPlayer[] = [
  {
    _id: "1",
    mlbId: 1,
    name: "Slugger",
    team: "NYY",
    position: "OF",
    adp: 10,
    tier: 1,
    value: 30,
    projection: {
      batting: { hr: 35, rbi: 100, runs: 95, sb: 8, avg: 0.285 },
    },
  },
  {
    _id: "2",
    mlbId: 2,
    name: "Starter",
    team: "LAD",
    position: "SP",
    adp: 20,
    tier: 1,
    value: 28,
    projection: {
      pitching: { strikeouts: 210, wins: 14, saves: 0, era: 3.1, whip: 1.05 },
    },
  },
];

describe("scoringAwareBaselinePlayers", () => {
  it("derives different baselines for points vs roto formats", () => {
    const roto = scoringAwareBaselinePlayers(
      players,
      "5x5",
      [
        { name: "HR", type: "batting" },
        { name: "RBI", type: "batting" },
        { name: "K", type: "pitching" },
      ],
      [{ position: "OF", count: 3 }]
    );
    const points = scoringAwareBaselinePlayers(
      players,
      "points",
      [{ name: "HR", type: "batting" }],
      [{ position: "OF", count: 3 }]
    );
    expect(roto[0].value).not.toBe(points[0].value);
  });

  it("applies scarcity multiplier from roster slot demand", () => {
    const lowDemand = scoringAwareBaselinePlayers(
      [players[0]],
      "5x5",
      [{ name: "HR", type: "batting" }],
      [{ position: "OF", count: 1 }]
    );
    const highDemand = scoringAwareBaselinePlayers(
      [players[0]],
      "5x5",
      [{ name: "HR", type: "batting" }],
      [{ position: "OF", count: 5 }]
    );
    expect(highDemand[0].value).toBeGreaterThan(lowDemand[0].value);
  });

  it("weights only selected roto categories for player type", () => {
    const compHitter: LeanPlayer = {
      ...players[0],
      _id: "10",
      mlbId: 10,
      name: "LightBat",
      value: 30,
      projection: {
        batting: { hr: 12, rbi: 55, runs: 62, sb: 7, avg: 0.255 },
      },
    };
    const input = [players[0], compHitter, players[1]];
    const onlyPitching = scoringAwareBaselinePlayers(
      input,
      "5x5",
      [{ name: "SV", type: "pitching" }],
      [{ position: "OF", count: 3 }]
    );
    const noBattingCats = scoringAwareBaselinePlayers(
      input,
      "5x5",
      [],
      [{ position: "OF", count: 3 }]
    );
    const fullMix = scoringAwareBaselinePlayers(
      input,
      "5x5",
      [
        { name: "HR", type: "batting" },
        { name: "RBI", type: "batting" },
        { name: "SV", type: "pitching" },
      ],
      [{ position: "OF", count: 3 }]
    );
    // Hitter should not move meaningfully when only pitching categories are selected.
    expect(onlyPitching[0].value).toBeCloseTo(noBattingCats[0].value, 6);
    expect(fullMix[0].value).toBeGreaterThan(onlyPitching[0].value);
    expect(fullMix[1].value).toBeLessThan(onlyPitching[1].value);
  });

  it("rewards lower ERA/WHIP when those categories are selected", () => {
    const pitcherA: LeanPlayer = {
      ...players[1],
      _id: "3",
      mlbId: 3,
      name: "Ace",
      projection: {
        pitching: { strikeouts: 180, wins: 12, saves: 0, era: 2.8, whip: 1.0 },
      },
    };
    const pitcherB: LeanPlayer = {
      ...players[1],
      _id: "4",
      mlbId: 4,
      name: "Risky",
      projection: {
        pitching: { strikeouts: 180, wins: 12, saves: 0, era: 4.1, whip: 1.3 },
      },
    };
    const out = scoringAwareBaselinePlayers(
      [pitcherA, pitcherB],
      "5x5",
      [
        { name: "ERA", type: "pitching" },
        { name: "WHIP", type: "pitching" },
      ],
      [{ position: "P", count: 9 }]
    );
    expect(out[0].value).toBeGreaterThan(out[1].value);
  });
});
