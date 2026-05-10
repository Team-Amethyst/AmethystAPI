/**
 * Shared Draftroom-default roster + synthetic catalog for calibration harness
 * (`scripts/calibrate-valuations.ts`) and golden tests.
 */
import type { LeanPlayer, NormalizedValuationInput, RosterSlot, ScoringCategory } from "../types/brain";

export const CALIBRATION_CATS_5X5: ScoringCategory[] = [
  { name: "R", type: "batting" },
  { name: "HR", type: "batting" },
  { name: "RBI", type: "batting" },
  { name: "SB", type: "batting" },
  { name: "AVG", type: "batting" },
  { name: "W", type: "pitching" },
  { name: "SV", type: "pitching" },
  { name: "ERA", type: "pitching" },
  { name: "WHIP", type: "pitching" },
  { name: "K", type: "pitching" },
];

/**
 * Same batting as 5x5; pitching omits **W** (wins) so closer/relief SV drives more of the
 * pitching baseline — "saves-focused" / saves-only style leagues (not identical to standard).
 */
export const CALIBRATION_CATS_SAVES_ONLY: ScoringCategory[] = [
  { name: "R", type: "batting" },
  { name: "HR", type: "batting" },
  { name: "RBI", type: "batting" },
  { name: "SB", type: "batting" },
  { name: "AVG", type: "batting" },
  { name: "SV", type: "pitching" },
  { name: "ERA", type: "pitching" },
  { name: "WHIP", type: "pitching" },
  { name: "K", type: "pitching" },
];

/** Draftroom web/mobile UI default roster — no generic `P`; 2 RP; 3 BN. */
export function draftroomUiDefaultRoster(): RosterSlot[] {
  return [
    { position: "C", count: 1 },
    { position: "1B", count: 1 },
    { position: "2B", count: 1 },
    { position: "SS", count: 1 },
    { position: "3B", count: 1 },
    { position: "MI", count: 1 },
    { position: "CI", count: 1 },
    { position: "OF", count: 3 },
    { position: "UTIL", count: 1 },
    { position: "SP", count: 5 },
    { position: "RP", count: 2 },
    { position: "BN", count: 3 },
  ];
}

/** Legacy harness shape: generic `P`, 3 RP, 7 BN. */
export function legacyEngineCalibrationRoster(): RosterSlot[] {
  return [
    { position: "C", count: 1 },
    { position: "1B", count: 1 },
    { position: "2B", count: 1 },
    { position: "3B", count: 1 },
    { position: "SS", count: 1 },
    { position: "CI", count: 1 },
    { position: "MI", count: 1 },
    { position: "OF", count: 3 },
    { position: "UTIL", count: 1 },
    { position: "SP", count: 5 },
    { position: "RP", count: 3 },
    { position: "P", count: 1 },
    { position: "BN", count: 7 },
  ];
}

export function buildDraftroomStandardValuationInput(
  over: Partial<NormalizedValuationInput> = {}
): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: draftroomUiDefaultRoster(),
    scoring_categories: CALIBRATION_CATS_5X5,
    total_budget: 260,
    num_teams: 12,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
    seed: 42,
    inflation_model: "replacement_slots_v2",
    scoring_format: "5x5",
    ...over,
  };
}

const TEAMS_AL_NL = [
  "NYY",
  "BOS",
  "LAD",
  "SDP",
  "CHC",
  "STL",
  "ATL",
  "HOU",
  "SEA",
  "TEX",
  "DET",
  "MIL",
] as const;

const POS_CYCLE = ["C", "1B", "2B", "3B", "SS", "OF", "OF", "OF", "SP", "RP"] as const;

function battingProj(id: number): Record<string, number> {
  const ab = 400 + (id % 80);
  const hr = 8 + (id % 35);
  const singlesEstimate = Math.max(0, ab - hr * 4 - id % 40);
  const tb = hr * 4 + singlesEstimate + (id % 50);
  const slg = tb / ab;
  const obp = Math.min(0.42, 0.3 + (id % 45) * 0.002);
  return {
    hr,
    rbi: 40 + (id % 70),
    runs: 45 + (id % 80),
    sb: id % 28,
    avg: Math.min(0.33, 0.22 + (id % 50) * 0.002),
    obp,
    atBats: ab,
    plateAppearances: Math.round(ab * 1.08),
    totalBases: tb,
    slg,
    ops: obp + slg,
  };
}

function pitchingProj(id: number): Record<string, number> {
  const ip = 45 + (id % 100);
  return {
    wins: 5 + (id % 12),
    strikeouts: 85 + (id % 110),
    saves: id % 35,
    holds: id % 18,
    era: Math.min(5.2, 3.0 + (id % 60) * 0.02),
    whip: Math.min(1.45, 1.05 + (id % 40) * 0.01),
    qualityStarts: id % 22,
    innings: ip,
    inningsPitched: ip,
    games_started: id % 3 === 0 ? 22 : id % 3 === 1 ? 8 : 0,
  };
}

export function buildSyntheticCalibrationDraftroomPool(): LeanPlayer[] {
  const out: LeanPlayer[] = [];
  for (let seq = 1; seq <= 620; seq++) {
    const mlbId = seq === 500 ? 777001 : seq;
    const pos = POS_CYCLE[seq % POS_CYCLE.length]!;
    const team = TEAMS_AL_NL[seq % TEAMS_AL_NL.length]!;
    const isPitch = pos === "SP" || pos === "RP";
    const batting =
      mlbId === 777001
        ? {
            hr: 32,
            rbi: 95,
            runs: 105,
            sb: 18,
            avg: 0.295,
            obp: 0.38,
            atBats: 560,
            plateAppearances: 620,
            totalBases: 305,
            slg: 0.545,
            ops: 0.925,
          }
        : battingProj(seq);
    const projection = isPitch
      ? { batting: battingProj(seq), pitching: pitchingProj(seq) }
      : { batting };
    const catalog_tier =
      mlbId === 777001 ? 1 : seq <= 48 ? 1 : seq <= 120 ? 2 : seq <= 260 ? 3 : 4;
    const value =
      mlbId === 777001 ? 52 : Math.max(1.5, 42 - seq * 0.055 + (isPitch ? 2 : 0));
    out.push({
      _id: `synth_${mlbId}`,
      mlbId,
      name: `Synthetic ${mlbId}`,
      team,
      position: pos,
      catalog_rank: seq,
      catalog_tier,
      value: Math.round(value * 100) / 100,
      projection,
    });
  }
  return out;
}
