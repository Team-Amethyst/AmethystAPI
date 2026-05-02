import { describe, expect, it } from "vitest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";
import { isPitcherPosition } from "../src/services/recommendedBid";

function mkOf(id: number, value: number): LeanPlayer {
  return {
    _id: `of_${id}`,
    mlbId: id,
    name: `Outfield ${id}`,
    team: "NYY",
    position: "OF",
    adp: id,
    tier: 1,
    value,
  };
}

function mkSp(id: number, value: number): LeanPlayer {
  return {
    _id: `sp_${id}`,
    mlbId: id + 1000,
    name: `Starter ${id}`,
    team: "BOS",
    position: "SP",
    adp: id + 50,
    tier: 2,
    value,
  };
}

function ladderInput(
  over: Partial<NormalizedValuationInput> = {}
): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: [
      { position: "OF", count: 5 },
      { position: "SP", count: 3 },
    ],
    scoring_categories: [{ name: "HR", type: "batting" }],
    total_budget: 260,
    num_teams: 12,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
    inflation_model: "global_v1",
    ...over,
  };
}

function assertMonotoneRecByBaseline(rows: { baseline_value: number; recommended_bid?: number }[]) {
  const sorted = [...rows].sort((a, b) => b.baseline_value - a.baseline_value);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i - 1]!.recommended_bid!).toBeGreaterThanOrEqual(
      sorted[i]!.recommended_bid!
    );
  }
}

describe("valuation dollar ladder (integration)", () => {
  const players: LeanPlayer[] = [
    mkOf(1, 62),
    mkOf(2, 55),
    mkOf(3, 48),
    mkOf(4, 40),
    mkOf(5, 33),
    mkOf(6, 26),
    mkSp(1, 44),
    mkSp(2, 36),
    mkSp(3, 28),
  ];

  it("keeps inflation_adjustment and edge identities on every row", () => {
    const res = executeValuationWorkflow(players, ladderInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const row of res.response.valuations) {
      const infl = row.inflation_adjustment ?? 0;
      const delta = row.adjusted_value - row.baseline_value;
      expect(Math.abs(infl - delta)).toBeLessThanOrEqual(0.02);
      const rb = row.recommended_bid ?? 0;
      const ta = row.team_adjusted_value ?? row.adjusted_value;
      const ed = row.edge ?? 0;
      expect(Math.abs(ed - (ta - rb))).toBeLessThanOrEqual(0.02);
    }
  });

  it("collapses team_adjusted to adjusted in symmetric pre-draft league", () => {
    const res = executeValuationWorkflow(players, ladderInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const row of res.response.valuations) {
      expect(row.team_adjusted_value).toBeDefined();
      expect(Math.abs(row.team_adjusted_value! - row.adjusted_value)).toBeLessThanOrEqual(
        0.02
      );
    }
  });

  it("keeps recommended_bid monotone by baseline within hitters and within pitchers", () => {
    const res = executeValuationWorkflow(players, ladderInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hitters = res.response.valuations.filter((r) => !isPitcherPosition(r.position));
    const pitchers = res.response.valuations.filter((r) => isPitcherPosition(r.position));
    assertMonotoneRecByBaseline(hitters);
    assertMonotoneRecByBaseline(pitchers);
  });

  it("aligns explain_v2 list and auction targets with baseline and adjusted", () => {
    const res = executeValuationWorkflow(players, ladderInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.response.valuations[0]!;
    expect(row.explain_v2?.list_value).toBe(row.baseline_value);
    expect(row.explain_v2?.auction_target).toBe(row.adjusted_value);
  });
});
