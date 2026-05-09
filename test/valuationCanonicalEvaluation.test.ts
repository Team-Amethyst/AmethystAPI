import { describe, expect, it } from "vitest";
import { DEFAULT_INFLATION_MODEL } from "../src/lib/valuationDefaults";
import { isPitcherPosition } from "../src/services/recommendedBid";
import { leagueSlotCapacity } from "../src/services/teamAdjustedValue";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput, RosterSlot } from "../src/types/brain";

/** Typical mixed 5×5 roster for a 12-team auction league (20 starters + bench slots represented as P). */
const STANDARD_TWELVE_TEAM_ROSTER: RosterSlot[] = [
  { position: "C", count: 1 },
  { position: "1B", count: 1 },
  { position: "2B", count: 1 },
  { position: "3B", count: 1 },
  { position: "SS", count: 1 },
  { position: "OF", count: 3 },
  { position: "UTIL", count: 1 },
  { position: "CI", count: 1 },
  { position: "MI", count: 1 },
  { position: "P", count: 9 },
];

const STANDARD_5X5_CATEGORIES = [
  { name: "R", type: "batting" as const },
  { name: "HR", type: "batting" as const },
  { name: "RBI", type: "batting" as const },
  { name: "SB", type: "batting" as const },
  { name: "AVG", type: "batting" as const },
  { name: "W", type: "pitching" as const },
  { name: "SV", type: "pitching" as const },
  { name: "ERA", type: "pitching" as const },
  { name: "WHIP", type: "pitching" as const },
  { name: "K", type: "pitching" as const },
];

const POS_ROTATION = ["SP", "RP", "OF", "SS", "C", "1B", "2B", "3B"] as const;

function battingProjFromRank(rank: number, size: number): Record<string, unknown> {
  const t = 1 - rank / Math.max(1, size - 1);
  const hr = Math.round(8 + t * 42);
  const rbi = Math.round(48 + t * 72);
  const runs = Math.round(52 + t * 68);
  const sb = Math.round(4 + t * 28);
  const ab = Math.round(380 + t * 220);
  const avg = 0.238 + t * 0.082;
  const obp = 0.31 + t * 0.095;
  const pa = Math.round(ab * 1.08);
  return { hr, rbi, runs, sb, avg, obp, atBats: ab, plateAppearances: pa };
}

function pitchingProjFromRank(rank: number, size: number): Record<string, unknown> {
  const t = 1 - rank / Math.max(1, size - 1);
  const k = Math.round(118 + t * 165);
  const w = Math.round(6 + t * 13);
  const sv = Math.round(t * 38);
  const ip = 54 + t * 148;
  const era = (5.45 - t * 3.25).toFixed(2);
  const whip = (1.42 - t * 0.42).toFixed(2);
  return {
    strikeouts: k,
    wins: w,
    saves: sv,
    era,
    whip,
    innings: ip.toFixed(1),
  };
}

function buildMixedCatalog(size: number): LeanPlayer[] {
  const out: LeanPlayer[] = [];
  for (let i = 0; i < size; i++) {
    const pos = POS_ROTATION[i % POS_ROTATION.length]!;
    const value = Math.max(1.2, 92 - i * 0.28);
    const projection =
      pos === "SP" || pos === "RP"
        ? { pitching: pitchingProjFromRank(i, size) }
        : { batting: battingProjFromRank(i, size) };
    out.push({
      _id: `p_${i}`,
      mlbId: i + 1,
      name: i === 0 ? "Canon Elite Star" : i === size - 1 ? "Canon Replacement Scrub" : `Player ${i}`,
      team: "TST",
      position: pos,
      adp: i + 1,
      tier: value > 45 ? 1 : value > 22 ? 2 : 4,
      value,
      ...(projection as LeanPlayer["projection"]),
    });
  }
  return out;
}

function standardTwelveTeamInput(
  over: Partial<NormalizedValuationInput> = {}
): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: STANDARD_TWELVE_TEAM_ROSTER,
    scoring_categories: STANDARD_5X5_CATEGORIES,
    total_budget: 260,
    num_teams: 12,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
    seed: 41,
    scoring_format: "5x5",
    ...over,
  };
}

describe("canonical auction_value (replacement_slots_v2 default)", () => {
  it("defaults omitted inflation_model to replacement_slots_v2", () => {
    const players = buildMixedCatalog(260);
    const input = standardTwelveTeamInput();
    const res = executeValuationWorkflow(players, input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.inflation_model).toBe(DEFAULT_INFLATION_MODEL);
  });

  it("sets auction_value equal to adjusted_value on every row", () => {
    const players = buildMixedCatalog(220);
    const res = executeValuationWorkflow(players, standardTwelveTeamInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const row of res.response.valuations) {
      expect(row.auction_value).toBeCloseTo(row.adjusted_value, 5);
    }
  });

  it("12-team $260 open auction: sum of top roster-slot auction dollars tracks remaining budget", () => {
    const players = buildMixedCatalog(300);
    const res = executeValuationWorkflow(players, standardTwelveTeamInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const budget = res.response.total_budget_remaining;
    const cap = leagueSlotCapacity(STANDARD_TWELVE_TEAM_ROSTER, 12);
    const sorted = [...res.response.valuations].sort(
      (a, b) => b.baseline_value - a.baseline_value
    );
    const k = Math.min(cap, sorted.length);
    const sumTop = sorted.slice(0, k).reduce((s, r) => s + r.auction_value, 0);
    /* Sum of top-$ players exceeds most of league budget but need not hit legacy Mongo-dollar scale. */
    expect(sumTop).toBeGreaterThan(budget * 0.68);
    expect(sumTop).toBeLessThan(budget * 1.28);
  });

  it("elite vs replacement land in broad realistic bands", () => {
    const players = buildMixedCatalog(280);
    const res = executeValuationWorkflow(players, standardTwelveTeamInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const elite = res.response.valuations.find((r) => r.name === "Canon Elite Star");
    const scrub = res.response.valuations.find((r) => r.name === "Canon Replacement Scrub");
    expect(elite).toBeDefined();
    expect(scrub).toBeDefined();
    expect(elite!.auction_value).toBeGreaterThanOrEqual(22);
    expect(elite!.auction_value).toBeLessThanOrEqual(52);
    expect(scrub!.auction_value).toBeGreaterThanOrEqual(1);
    expect(scrub!.auction_value).toBeLessThanOrEqual(4);
  });

  it("auction dollars are mostly monotone by baseline within hitter and pitcher groups (slack for scarcity)", () => {
    const players = buildMixedCatalog(260);
    const res = executeValuationWorkflow(players, standardTwelveTeamInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const bucket of ["hitters", "pitchers"] as const) {
      const rows = res.response.valuations.filter((r) =>
        bucket === "pitchers"
          ? isPitcherPosition(r.position)
          : !isPitcherPosition(r.position)
      );
      const ord = [...rows].sort((a, b) => b.baseline_value - a.baseline_value);
      let violations = 0;
      for (let i = 1; i < ord.length; i++) {
        const higherBaseline = ord[i - 1]!;
        const lowerBaseline = ord[i]!;
        if (lowerBaseline.auction_value > higherBaseline.auction_value + 6) {
          violations++;
        }
      }
      expect(violations / Math.max(1, ord.length - 1)).toBeLessThan(0.22);
    }
  });
});
