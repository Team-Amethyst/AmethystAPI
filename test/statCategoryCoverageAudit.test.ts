/**
 * Coverage audit: each supported roto category moves baseline in the expected direction
 * on synthetic pools; strict_scoring_categories accepts the full supported matrix.
 */
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_ROTO_BATTING,
  SUPPORTED_ROTO_PITCHING,
} from "../src/lib/scoringCategorySupport";
import {
  buildDraftroomStandardValuationInput,
  buildSyntheticCalibrationDraftroomPool,
} from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import type { LeanPlayer, RosterSlot, ScoringCategory } from "../src/types/brain";

const rosterHitters: RosterSlot[] = [{ position: "OF", count: 12 }];
const rosterPitchers: RosterSlot[] = [{ position: "SP", count: 12 }];

function mkHitter(id: string, mlbId: number, batting: Record<string, unknown>): LeanPlayer {
  return {
    _id: id,
    mlbId,
    name: id,
    team: "NYY",
    position: "OF",
    catalog_rank: 50,
    catalog_tier: 2,
    value: 20,
    projection: { batting },
  };
}

function mkPitcher(id: string, mlbId: number, pitching: Record<string, unknown>): LeanPlayer {
  return {
    _id: id,
    mlbId,
    name: id,
    team: "LAD",
    position: "SP",
    catalog_rank: 50,
    catalog_tier: 2,
    value: 18,
    projection: { pitching },
  };
}

const baseBatting = (): Record<string, unknown> => ({
  runs: 75,
  hr: 20,
  rbi: 70,
  sb: 12,
  avg: 0.265,
  obp: 0.34,
  slg: 0.44,
  ops: 0.78,
  totalBases: 250,
  atBats: 580,
  plateAppearances: 640,
});

const basePitching = (): Record<string, unknown> => ({
  wins: 12,
  saves: 0,
  holds: 5,
  strikeouts: 180,
  era: 3.8,
  whip: 1.22,
  qualityStarts: 18,
  innings: 175,
  inningsPitched: 175,
});

describe("stat category coverage — roto z baseline directionality", () => {
  it("R / HR / RBI / SB / TB: higher counting stat ⇒ higher baseline (single-category)", () => {
    const catPairs: { cat: string; low: Partial<typeof baseBatting>; high: Partial<typeof baseBatting> }[] =
      [
        { cat: "R", low: { runs: 40 }, high: { runs: 110 } },
        { cat: "HR", low: { hr: 8 }, high: { hr: 42 } },
        { cat: "RBI", low: { rbi: 45 }, high: { rbi: 115 } },
        { cat: "SB", low: { sb: 2 }, high: { sb: 35 } },
        { cat: "TB", low: { totalBases: 180 }, high: { totalBases: 320 } },
      ];
    for (const { cat, low, high } of catPairs) {
      const pool = [
        mkHitter("lo", 1, { ...baseBatting(), ...low }),
        mkHitter("mid", 2, { ...baseBatting(), runs: 75, hr: 20, rbi: 70, sb: 12, totalBases: 250 }),
        mkHitter("hi", 3, { ...baseBatting(), ...high }),
      ];
      const cats: ScoringCategory[] = [{ name: cat, type: "batting" }];
      const out = scoringAwareBaselinePlayers(pool, "5x5", cats, rosterHitters);
      expect(out.find((p) => p._id === "hi")!.value).toBeGreaterThan(
        out.find((p) => p._id === "lo")!.value
      );
    }
  });

  it("AVG / OBP / SLG / OPS: better rate ⇒ higher baseline (single-category)", () => {
    const cases: { cat: string; worse: Partial<typeof baseBatting>; better: Partial<typeof baseBatting> }[] =
      [
        { cat: "AVG", worse: { avg: 0.21 }, better: { avg: 0.31 } },
        { cat: "OBP", worse: { obp: 0.28 }, better: { obp: 0.41 } },
        { cat: "SLG", worse: { slg: 0.35 }, better: { slg: 0.52 } },
        { cat: "OPS", worse: { ops: 0.62 }, better: { ops: 0.95 } },
      ];
    for (const { cat, worse, better } of cases) {
      const pool = [
        mkHitter("w", 10, { ...baseBatting(), ...worse }),
        mkHitter("m", 11, { ...baseBatting() }),
        mkHitter("b", 12, { ...baseBatting(), ...better }),
      ];
      const cats: ScoringCategory[] = [{ name: cat, type: "batting" }];
      const out = scoringAwareBaselinePlayers(pool, "5x5", cats, rosterHitters);
      expect(out.find((p) => p._id === "b")!.value).toBeGreaterThan(
        out.find((p) => p._id === "w")!.value
      );
    }
  });

  it("W / SV / HLD / SV+HLD / K / QS: higher counting or strikeouts ⇒ higher baseline", () => {
    const cases: {
      cat: string;
      low: Partial<typeof basePitching>;
      high: Partial<typeof basePitching>;
    }[] = [
      { cat: "W", low: { wins: 4 }, high: { wins: 17 } },
      { cat: "SV", low: { saves: 1 }, high: { saves: 38 } },
      { cat: "HLD", low: { holds: 0 }, high: { holds: 28 } },
      { cat: "SV+HLD", low: { saves: 2, holds: 3 }, high: { saves: 35, holds: 12 } },
      { cat: "K", low: { strikeouts: 65 }, high: { strikeouts: 245 } },
      { cat: "QS", low: { qualityStarts: 4 }, high: { qualityStarts: 26 } },
    ];
    for (const { cat, low, high } of cases) {
      const pool = [
        mkPitcher("lo", 100, { ...basePitching(), ...low }),
        mkPitcher("mid", 101, { ...basePitching() }),
        mkPitcher("hi", 102, { ...basePitching(), ...high }),
      ];
      const cats: ScoringCategory[] = [{ name: cat, type: "pitching" }];
      const out = scoringAwareBaselinePlayers(pool, "5x5", cats, rosterPitchers);
      expect(out.find((p) => p._id === "hi")!.value).toBeGreaterThan(
        out.find((p) => p._id === "lo")!.value
      );
    }
  });

  it("ERA / WHIP: lower rate ⇒ higher baseline", () => {
    for (const cat of ["ERA", "WHIP"] as const) {
      const worse = cat === "ERA" ? { era: 5.4 } : { whip: 1.48 };
      const better = cat === "ERA" ? { era: 2.85 } : { whip: 1.02 };
      const pool = [
        mkPitcher("bad", 200, { ...basePitching(), ...worse }),
        mkPitcher("mid", 201, { ...basePitching() }),
        mkPitcher("good", 202, { ...basePitching(), ...better }),
      ];
      const cats: ScoringCategory[] = [{ name: cat, type: "pitching" }];
      const out = scoringAwareBaselinePlayers(pool, "5x5", cats, rosterPitchers);
      expect(out.find((p) => p._id === "good")!.value).toBeGreaterThan(
        out.find((p) => p._id === "bad")!.value
      );
    }
  });

  it("K/9: higher rate ⇒ higher baseline at same IP", () => {
    const pool = [
      mkPitcher("lo", 300, {
        ...basePitching(),
        innings: 170,
        inningsPitched: 170,
        strikeouts: 120,
      }),
      mkPitcher("hi", 301, {
        ...basePitching(),
        innings: 170,
        inningsPitched: 170,
        strikeouts: 238,
      }),
    ];
    const cats: ScoringCategory[] = [{ name: "K/9", type: "pitching" }];
    const out = scoringAwareBaselinePlayers(pool, "5x5", cats, rosterPitchers);
    expect(out.find((p) => p._id === "hi")!.value).toBeGreaterThan(
      out.find((p) => p._id === "lo")!.value
    );
  });

  it("SO alias normalizes to K for wiring", () => {
    const pool = [
      mkPitcher("lo", 400, { ...basePitching(), strikeouts: 90 }),
      mkPitcher("hi", 401, { ...basePitching(), strikeouts: 220 }),
    ];
    const soCats: ScoringCategory[] = [{ name: "SO", type: "pitching" }];
    const kCats: ScoringCategory[] = [{ name: "K", type: "pitching" }];
    const outSo = scoringAwareBaselinePlayers(pool, "5x5", soCats, rosterPitchers);
    const outK = scoringAwareBaselinePlayers(pool, "5x5", kCats, rosterPitchers);
    expect(outSo.find((p) => p._id === "hi")!.value).toBe(outK.find((p) => p._id === "hi")!.value);
  });

  it("missing optional batting rate fields fall back without crashing (AVG uses AB fallback)", () => {
    const pool = [
      mkHitter("thin", 500, {
        runs: 70,
        hr: 18,
        rbi: 65,
        sb: 8,
        avg: 0.27,
        totalBases: 240,
      }),
      mkHitter("full", 501, baseBatting()),
    ];
    const cats: ScoringCategory[] = [{ name: "AVG", type: "batting" }];
    const out = scoringAwareBaselinePlayers(pool, "5x5", cats, rosterHitters);
    expect(out.every((p) => p.value >= 1)).toBe(true);
  });
});

describe("strict_scoring_categories with full supported matrix", () => {
  it("passes when every supported batting + pitching category is listed", () => {
    const pool = buildSyntheticCalibrationDraftroomPool().slice(0, 200);
    const cats: ScoringCategory[] = [
      ...[...SUPPORTED_ROTO_BATTING].map((name) => ({ name, type: "batting" as const })),
      ...[...SUPPORTED_ROTO_PITCHING].map((name) => ({ name, type: "pitching" as const })),
    ];
    const input = buildDraftroomStandardValuationInput({
      scoring_categories: cats,
      strict_scoring_categories: true,
    });
    const wf = executeValuationWorkflow(pool, input, {});
    expect(wf.ok).toBe(true);
    if (!wf.ok) return;
    expect(wf.response.scoring_category_warnings).toBeUndefined();
  });
});
