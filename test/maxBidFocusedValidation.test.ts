import { describe, expect, it } from "vitest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { isPitcherPosition } from "../src/services/recommendedBid";
import { computeMaxBidDollars } from "../src/services/maxBid";
import type { LeanPlayer, NormalizedValuationInput, ValuedPlayer } from "../src/types/brain";

function assertRbLeqMb(rows: ValuedPlayer[], tol = 0.02) {
  for (const r of rows) {
    expect(r.recommended_bid).toBeDefined();
    expect(r.max_bid).toBeDefined();
    expect(r.recommended_bid!).toBeLessThanOrEqual(r.max_bid! + tol);
  }
}

function assertEdgeIdentity(rows: ValuedPlayer[], tol = 0.02) {
  for (const r of rows) {
    const ta = r.team_adjusted_value ?? r.adjusted_value;
    const rb = r.recommended_bid ?? 0;
    expect(Math.abs((r.edge ?? 0) - (ta - rb))).toBeLessThanOrEqual(tol);
  }
}

function sortByBaselineDesc(rows: ValuedPlayer[]) {
  return [...rows].sort((a, b) => b.baseline_value - a.baseline_value);
}

/** Post-clamp suggested bid should stay monotone by list strength within role (regression for UI sort). */
function assertMonotoneRbByBaseline(rows: ValuedPlayer[]) {
  const sorted = sortByBaselineDesc(rows);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i - 1]!.recommended_bid!).toBeGreaterThanOrEqual(
      sorted[i]!.recommended_bid! - 0.02
    );
  }
}

const mixedPool: LeanPlayer[] = [
  {
    _id: "of1",
    mlbId: 1,
    name: "OF Star",
    team: "NYY",
    position: "OF",
    catalog_rank: 1,
    catalog_tier: 1,
    value: 55,
  },
  {
    _id: "of2",
    mlbId: 2,
    name: "OF Mid",
    team: "BOS",
    position: "OF",
    catalog_rank: 5,
    catalog_tier: 2,
    value: 32,
  },
  {
    _id: "sp1",
    mlbId: 3,
    name: "SP Ace",
    team: "MIL",
    position: "SP",
    catalog_rank: 20,
    catalog_tier: 1,
    value: 28,
  },
];

function symmetricInput(
  over: Partial<NormalizedValuationInput> = {}
): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: [
      { position: "OF", count: 2 },
      { position: "SP", count: 1 },
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

describe("max_bid focused validation", () => {
  it("1. recommended_bid never exceeds max_bid (global + v2)", () => {
    const g = executeValuationWorkflow(mixedPool, symmetricInput());
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    assertRbLeqMb(g.response.valuations);

    const v2Players: LeanPlayer[] = [
      ...mixedPool,
      ...Array.from({ length: 40 }, (_, i) => ({
        _id: `f${i}`,
        mlbId: 100 + i,
        name: `Fill${i}`,
        team: "NYY",
        position: "OF",
        catalog_rank: 50 + i,
        catalog_tier: 3,
        value: 5,
      })),
    ];
    const v2 = executeValuationWorkflow(v2Players, {
      ...symmetricInput(),
      inflation_model: "replacement_slots_v2",
    });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    assertRbLeqMb(v2.response.valuations);
  });

  it("2. max_bid is not a default alias of recommended_bid: some rows keep headroom under ceiling", () => {
    const res = executeValuationWorkflow(mixedPool, symmetricInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const spread = res.response.valuations.filter(
      (r) => (r.max_bid ?? 0) - (r.recommended_bid ?? 0) > 0.05
    );
    expect(spread.length).toBeGreaterThan(0);
  });

  it("3. max_bid tracks team_adjusted_value (strict increase when FMV headroom does not bind both rows)", () => {
    const local: LeanPlayer[] = [
      {
        _id: "bp1",
        mlbId: 401,
        name: "BudgetOF",
        team: "NYY",
        position: "OF",
        catalog_rank: 10,
        catalog_tier: 2,
        value: 18,
      },
    ];
    const common = symmetricInput({
      user_team_id: "team_1",
      roster_slots: [{ position: "OF", count: 1 }],
      drafted_players: [],
    });
    const highBudget = executeValuationWorkflow(local, {
      ...common,
      budget_by_team_id: { team_1: 20, team_2: 10, team_3: 10 },
    });
    const lowBudget = executeValuationWorkflow(local, {
      ...common,
      budget_by_team_id: { team_1: 8, team_2: 16, team_3: 16 },
    });
    expect(highBudget.ok && lowBudget.ok).toBe(true);
    if (!highBudget.ok || !lowBudget.ok) return;
    const hi = highBudget.response.valuations[0]!;
    const lo = lowBudget.response.valuations[0]!;
    expect(hi.auction_value).toBeCloseTo(lo.auction_value, 4);
    expect(hi.team_adjusted_value!).toBeGreaterThan(lo.team_adjusted_value!);
    expect(hi.max_bid!).toBeGreaterThanOrEqual(lo.max_bid! - 0.02);
    const fmPin = (x: ValuedPlayer) => x.adjusted_value * 1.095;
    const hiPin = Math.abs(hi.max_bid! - fmPin(hi)) < 0.08;
    const loPin = Math.abs(lo.max_bid! - fmPin(lo)) < 0.08;
    if (!(hiPin && loPin)) {
      expect(hi.max_bid!).toBeGreaterThan(lo.max_bid! + 0.01);
    }
    const rowStub = { baseline_tier: 3 } as unknown as ValuedPlayer;
    const lowB = computeMaxBidDollars({
      row: rowStub,
      base: 28,
      adjustedValue: 60,
      minAuctionBid: 1,
      multipliers: {
        need: 1.08,
        budget: 0.95,
        dollars_per_slot: 1.02,
        slot_scarcity: 1.04,
        replacement_dropoff: 1.05,
      },
      symmetricOpen: false,
      openSeatFraction: 0.85,
    });
    const highB = computeMaxBidDollars({
      row: rowStub,
      base: 44,
      adjustedValue: 60,
      minAuctionBid: 1,
      multipliers: {
        need: 1.08,
        budget: 0.95,
        dollars_per_slot: 1.02,
        slot_scarcity: 1.04,
        replacement_dropoff: 1.05,
      },
      symmetricOpen: false,
      openSeatFraction: 0.85,
    });
    expect(highB).toBeGreaterThan(lowB);
  });

  it("4. huge baseline_value cannot create runaway max_bid (unit-level cap)", () => {
    const row = {
      player_id: "x",
      name: "X",
      position: "OF",
      team: "NYY",
      catalog_rank: 1,
      catalog_tier: 1,
      baseline_rank: 1,
      auction_rank: 1,
      baseline_tier: 1,
      auction_tier: 1,
      baseline_value: 200,
      auction_value: 15,
      adjusted_value: 15,
      indicator: "Fair Value",
      inflation_factor: 1,
    } as ValuedPlayer;
    const mb = computeMaxBidDollars({
      row,
      base: 15,
      adjustedValue: 15,
      minAuctionBid: 1,
      multipliers: {
        need: 1,
        budget: 1,
        dollars_per_slot: 1,
        slot_scarcity: 1,
        replacement_dropoff: 1,
      },
      symmetricOpen: true,
      openSeatFraction: 1,
    });
    expect(mb).toBeLessThanOrEqual(15 * 1.12 + 0.02);
    expect(mb).toBeLessThan(80);
  });

  it("5. post-clamp recommended_bid stays monotone by baseline within hitters and pitchers", () => {
    const ladderPool: LeanPlayer[] = [
      { _id: "a", mlbId: 1, name: "H1", team: "NYY", position: "OF", catalog_rank: 1, catalog_tier: 1, value: 62 },
      { _id: "b", mlbId: 2, name: "H2", team: "NYY", position: "OF", catalog_rank: 2, catalog_tier: 1, value: 50 },
      { _id: "c", mlbId: 3, name: "H3", team: "NYY", position: "OF", catalog_rank: 3, catalog_tier: 2, value: 38 },
      { _id: "d", mlbId: 4, name: "P1", team: "BOS", position: "SP", catalog_rank: 4, catalog_tier: 1, value: 40 },
      { _id: "e", mlbId: 5, name: "P2", team: "BOS", position: "SP", catalog_rank: 5, catalog_tier: 2, value: 28 },
    ];
    const res = executeValuationWorkflow(ladderPool, symmetricInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hit = res.response.valuations.filter((r) => !isPitcherPosition(r.position));
    const pit = res.response.valuations.filter((r) => isPitcherPosition(r.position));
    assertMonotoneRbByBaseline(hit);
    assertMonotoneRbByBaseline(pit);
    for (const r of res.response.valuations) {
      expect(r.explain_v2?.auction_target).toBe(r.adjusted_value);
      expect(r.explain_v2?.list_value).toBe(r.baseline_value);
    }
  });

  it("6. edge equals team_adjusted_value − recommended_bid after clamp (symmetric: same as adjusted − rb)", () => {
    const res = executeValuationWorkflow(mixedPool, symmetricInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    assertEdgeIdentity(res.response.valuations);
    for (const r of res.response.valuations) {
      expect(r.team_adjusted_value).toBeDefined();
      expect(
        Math.abs((r.edge ?? 0) - ((r.team_adjusted_value ?? 0) - (r.recommended_bid ?? 0)))
      ).toBeLessThanOrEqual(0.02);
    }
  });

  it("7. symmetric open: max_bid tracks team_adjusted_value ≈ adjusted_value (no artificial team gap)", () => {
    const res = executeValuationWorkflow(mixedPool, symmetricInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const r of res.response.valuations) {
      expect(Math.abs((r.team_adjusted_value ?? 0) - r.adjusted_value)).toBeLessThanOrEqual(0.02);
      expect(r.max_bid!).toBeLessThanOrEqual(r.adjusted_value * 1.12 + 0.02);
      expect(r.max_bid!).toBeGreaterThanOrEqual(r.adjusted_value - 0.02);
    }
  });
});
