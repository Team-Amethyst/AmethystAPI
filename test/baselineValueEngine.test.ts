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
});
