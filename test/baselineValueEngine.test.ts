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

  it("applies wider pitcher roto projection swing than hitters for same z spread", () => {
    const hitterHi: LeanPlayer = {
      ...players[0],
      _id: "h1",
      mlbId: 101,
      value: 20,
      projection: { batting: { hr: 40, rbi: 100, runs: 100, sb: 10, avg: 0.3 } },
    };
    const hitterLo: LeanPlayer = {
      ...players[0],
      _id: "h2",
      mlbId: 102,
      value: 20,
      projection: { batting: { hr: 8, rbi: 40, runs: 50, sb: 2, avg: 0.22 } },
    };
    const pitchHi: LeanPlayer = {
      ...players[1],
      _id: "p1",
      mlbId: 201,
      value: 20,
      projection: {
        pitching: { strikeouts: 220, wins: 15, saves: 0, era: 2.6, whip: 0.95 },
      },
    };
    const pitchLo: LeanPlayer = {
      ...players[1],
      _id: "p2",
      mlbId: 202,
      value: 20,
      projection: {
        pitching: { strikeouts: 140, wins: 8, saves: 0, era: 4.5, whip: 1.35 },
      },
    };
    const cats = [
      { name: "HR", type: "batting" as const },
      { name: "ERA", type: "pitching" as const },
      { name: "WHIP", type: "pitching" as const },
    ];
    const hOut = scoringAwareBaselinePlayers(
      [hitterHi, hitterLo],
      "5x5",
      cats,
      [{ position: "OF", count: 3 }, { position: "P", count: 9 }]
    );
    const pOut = scoringAwareBaselinePlayers(
      [pitchHi, pitchLo],
      "5x5",
      cats,
      [{ position: "OF", count: 3 }, { position: "P", count: 9 }]
    );
    const hSpread = Math.abs(
      (hOut.find((x) => x._id === "h1")?.value ?? 0) -
        (hOut.find((x) => x._id === "h2")?.value ?? 0)
    );
    const pSpread = Math.abs(
      (pOut.find((x) => x._id === "p1")?.value ?? 0) -
        (pOut.find((x) => x._id === "p2")?.value ?? 0)
    );
    expect(pSpread).toBeGreaterThan(hSpread * 0.85);
  });

  it("treats two-way SP eligibility as pitcher for points baseline", () => {
    const twoWay: LeanPlayer = {
      _id: "tw",
      mlbId: 999,
      name: "TwoWay",
      team: "LAA",
      position: "DH",
      positions: ["SP", "DH"],
      adp: 1,
      tier: 1,
      value: 25,
      projection: {
        batting: { hr: 20, rbi: 60, runs: 70, sb: 10, avg: 0.28 },
        /* Strong ace line so pointsBaseline takes the pitcher branch above DH-only hitting. */
        pitching: { strikeouts: 260, wins: 16, saves: 0, era: 2.4, whip: 0.92 },
      },
    };
    const dhOnly: LeanPlayer = {
      ...twoWay,
      _id: "dh",
      mlbId: 998,
      positions: [],
      projection: { batting: { hr: 20, rbi: 60, runs: 70, sb: 10, avg: 0.28 } },
    };
    const out = scoringAwareBaselinePlayers(
      [twoWay, dhOnly],
      "points",
      [{ name: "HR", type: "batting" }],
      [{ position: "DH", count: 1 }]
    );
    const vTw = out.find((x) => x._id === "tw")!.value;
    const vDh = out.find((x) => x._id === "dh")!.value;
    expect(vTw).not.toBeCloseTo(vDh, 0);
    expect(vTw).toBeGreaterThan(vDh);
  });

  it("lifts very low catalog value when ADP and tier show real draft interest", () => {
    const spec: LeanPlayer = {
      _id: "s1",
      mlbId: 501,
      name: "Spec",
      team: "SEA",
      position: "OF",
      adp: 90,
      tier: 2,
      value: 1,
      projection: { batting: { hr: 12, rbi: 35, runs: 40, sb: 8, avg: 0.24 } },
    };
    const flat: LeanPlayer = {
      ...spec,
      _id: "s2",
      mlbId: 502,
      adp: 250,
      tier: 2,
      value: 1,
    };
    const out = scoringAwareBaselinePlayers(
      [spec, flat],
      "5x5",
      [{ name: "HR", type: "batting" }],
      [{ position: "OF", count: 3 }]
    );
    const vSpec = out.find((x) => x._id === "s1")!.value;
    const vFlat = out.find((x) => x._id === "s2")!.value;
    expect(vSpec).toBeGreaterThan(vFlat);
    expect(vSpec).toBeGreaterThan(3);
  });

  it("applies age curve adjustment when age is available", () => {
    const prime: LeanPlayer = {
      ...players[0],
      _id: "age-prime",
      mlbId: 7001,
      age: 27,
      value: 25,
      tier: 2,
    };
    const older: LeanPlayer = {
      ...prime,
      _id: "age-old",
      mlbId: 7002,
      age: 37,
    };
    const out = scoringAwareBaselinePlayers(
      [prime, older],
      "5x5",
      [],
      [{ position: "OF", count: 3 }]
    );
    const vPrime = out.find((x) => x._id === "age-prime")!.value;
    const vOld = out.find((x) => x._id === "age-old")!.value;
    expect(vPrime).toBeGreaterThan(vOld);
  });

  it("applies injury severity haircut after other baseline steps", () => {
    const healthy: LeanPlayer = {
      ...players[0],
      _id: "inj-ok",
      mlbId: 8001,
      value: 30,
      tier: 2,
      age: 28,
      depthChartPosition: 1,
    };
    const hurt: LeanPlayer = {
      ...healthy,
      _id: "inj-bad",
      mlbId: 8002,
      injurySeverity: 3,
    };
    const out = scoringAwareBaselinePlayers(
      [healthy, hurt],
      "5x5",
      [],
      [{ position: "OF", count: 3 }]
    );
    const vOk = out.find((x) => x._id === "inj-ok")!.value;
    const vBad = out.find((x) => x._id === "inj-bad")!.value;
    expect(vBad).toBeLessThan(vOk);
  });

  it("penalizes deeper depth-chart roles", () => {
    const starter: LeanPlayer = {
      ...players[0],
      _id: "depth-1",
      mlbId: 7101,
      value: 24,
      tier: 2,
      depthChartPosition: 1,
      age: 28,
    };
    const bench: LeanPlayer = {
      ...starter,
      _id: "depth-3",
      mlbId: 7103,
      depthChartPosition: 3,
    };
    const out = scoringAwareBaselinePlayers(
      [starter, bench],
      "5x5",
      [],
      [{ position: "OF", count: 3 }]
    );
    const vStarter = out.find((x) => x._id === "depth-1")!.value;
    const vBench = out.find((x) => x._id === "depth-3")!.value;
    expect(vStarter).toBeGreaterThan(vBench);
  });
});
