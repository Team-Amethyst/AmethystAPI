import { describe, expect, it } from "vitest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput, ScoringCategory } from "../src/types/brain";

/** Regression-only fake category name — must stay unsupported by the engine. */
const UNSUPPORTED_FAKE_CAT = "ZZZ_UNSUPPORTED_FAKE";

const tinyPool: LeanPlayer[] = [
  {
    _id: "a1",
    mlbId: 1,
    name: "One",
    team: "NYY",
    position: "OF",
    catalog_rank: 5,
    catalog_tier: 1,
    value: 30,
    projection: {
      batting: {
        hr: 25,
        rbi: 80,
        runs: 90,
        sb: 12,
        avg: 0.28,
        atBats: 550,
        plateAppearances: 600,
      },
    },
  },
  {
    _id: "p1",
    mlbId: 2,
    name: "Ace",
    team: "LAD",
    position: "SP",
    catalog_rank: 20,
    catalog_tier: 1,
    value: 28,
    projection: {
      pitching: {
        wins: 14,
        strikeouts: 210,
        saves: 0,
        holds: 4,
        era: 2.9,
        whip: 1.05,
        qualityStarts: 22,
        innings: 180,
        inningsPitched: 180,
        games_started: 32,
      },
    },
  },
];

const baseCats: ScoringCategory[] = [
  { name: "HR", type: "batting" },
  { name: "R", type: "batting" },
  { name: "W", type: "pitching" },
  { name: "ERA", type: "pitching" },
];

function minimalInput(over: Partial<NormalizedValuationInput> = {}): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: [
      { position: "OF", count: 3 },
      { position: "SP", count: 5 },
    ],
    scoring_categories: baseCats,
    total_budget: 260,
    num_teams: 12,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
    inflation_model: "replacement_slots_v2",
    ...over,
  };
}

describe("executeValuationWorkflow scoring category support", () => {
  it("returns scoring_category_warnings when unsupported categories are present", () => {
    const res = executeValuationWorkflow(tinyPool, {
      ...minimalInput(),
      scoring_categories: [...baseCats, { name: UNSUPPORTED_FAKE_CAT, type: "batting" }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.scoring_category_warnings?.length).toBeGreaterThan(0);
    expect(res.response.scoring_category_warnings![0]).toContain(UNSUPPORTED_FAKE_CAT);
  });

  it("fails closed when strict_scoring_categories and unsupported names", () => {
    const res = executeValuationWorkflow(tinyPool, {
      ...minimalInput(),
      scoring_categories: [...baseCats, { name: UNSUPPORTED_FAKE_CAT, type: "batting" }],
      strict_scoring_categories: true,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues[0]).toContain("Unsupported scoring categories");
  });

  it("passes strict_scoring_categories when only modeled categories including HLD", () => {
    const res = executeValuationWorkflow(tinyPool, {
      ...minimalInput(),
      scoring_categories: [...baseCats, { name: "HLD", type: "pitching" }],
      strict_scoring_categories: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.scoring_category_warnings).toBeUndefined();
  });

  it("omits warnings when all categories are supported", () => {
    const res = executeValuationWorkflow(tinyPool, minimalInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.scoring_category_warnings).toBeUndefined();
  });
});
