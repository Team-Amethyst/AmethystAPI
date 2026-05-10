import { describe, expect, it } from "vitest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";

function mkLean(id: number, over: Partial<LeanPlayer> = {}): LeanPlayer {
  const base: LeanPlayer = {
    _id: `risk-${id}`,
    mlbId: id,
    name: `RiskPlayer${id}`,
    team: "TST",
    position: "OF",
    adp: 40,
    tier: 5,
    value: 20,
    projection: {
      batting: { hr: 25, rbi: 85, runs: 80, sb: 5, avg: 0.27 },
    },
  };
  return {
    ...base,
    ...over,
    _id: `risk-${id}`,
    mlbId: id,
    position: over.position ?? "OF",
    projection: {
      ...(base.projection as Record<string, unknown>),
      ...(over.projection as Record<string, unknown> | undefined),
    },
  };
}

function baseInput(
  over: Partial<NormalizedValuationInput> = {}
): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: [{ position: "OF", count: 3 }],
    scoring_categories: [
      { name: "HR", type: "batting" },
      { name: "RBI", type: "batting" },
      { name: "R", type: "batting" },
      { name: "SB", type: "batting" },
      { name: "AVG", type: "batting" },
    ],
    total_budget: 260,
    num_teams: 2,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
    seed: 11,
    inflation_model: "global_v1",
    ...over,
  };
}

const filler = Array.from({ length: 24 }, (_, i) =>
  mkLean(900 + i, { position: "OF", tier: 6, adp: 200 + i })
);

describe("baseline risk explainability", () => {
  it("includes risk multipliers on baseline_components for every row", () => {
    const target = mkLean(1, { depthChartPosition: 2 });
    const res = executeValuationWorkflow([target, ...filler], baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.response.valuations.find((v) => v.player_id === "1");
    expect(row?.baseline_components?.age_multiplier).toBeDefined();
    expect(row?.baseline_components?.depth_multiplier).toBeDefined();
    expect(row?.baseline_components?.age_depth_combined_multiplier).toBeDefined();
    expect(row?.baseline_components?.injury_severity).toBe(0);
    expect(row?.baseline_components?.injury_multiplier).toBe(1);
  });

  it("echoes risk fields on valuation_explain when explain_valuation_rows is true", () => {
    const target = mkLean(1, { age: 40, depthChartPosition: 2 });
    const res = executeValuationWorkflow(
      [target, ...filler],
      baseInput({ explain_valuation_rows: true })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.response.valuations.find((v) => v.player_id === "1");
    const ex = row?.valuation_explain;
    expect(ex).toBeDefined();
    expect(ex!.age_years).toBe(40);
    expect(ex!.age_multiplier).toBeLessThan(1);
    expect(ex!.depth_chart_position_resolved).toBe(2);
    expect(ex!.depth_multiplier).toBe(1);
    expect(ex!.injury_severity).toBe(0);
    expect(ex!.injury_multiplier).toBe(1);
    expect(ex!.effective_positions.length).toBeGreaterThan(0);
  });

  it("does not change auction_value when explain_valuation_rows is toggled", () => {
    const target = mkLean(1, {
      age: 37,
      depthChartPosition: 3,
      injurySeverity: 2,
    });
    const pool = [target, ...filler];
    const plain = executeValuationWorkflow(pool, baseInput());
    const explained = executeValuationWorkflow(
      pool,
      baseInput({ explain_valuation_rows: true })
    );
    expect(plain.ok && explained.ok).toBe(true);
    if (!plain.ok || !explained.ok) return;
    const a = plain.response.valuations.find((v) => v.player_id === "1")!;
    const b = explained.response.valuations.find((v) => v.player_id === "1")!;
    expect(a.auction_value).toBe(b.auction_value);
    expect(a.baseline_value).toBe(b.baseline_value);
    expect(a.valuation_explain).toBeUndefined();
    expect(b.valuation_explain?.injury_severity).toBe(2);
    expect(b.valuation_explain?.injury_multiplier).toBeLessThan(1);
  });

  it("surfaces reserve depth and severe injury on explain rows", () => {
    const reserve = mkLean(2, { age: 27, depthChartPosition: 4 });
    const hurt = mkLean(3, { age: 27, depthChartPosition: 2, injurySeverity: 3 });
    const res = executeValuationWorkflow(
      [reserve, hurt, ...filler],
      baseInput({ explain_valuation_rows: true })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r2 = res.response.valuations.find((v) => v.player_id === "2")!;
    const r3 = res.response.valuations.find((v) => v.player_id === "3")!;
    expect(r2.valuation_explain!.depth_chart_position_resolved).toBe(4);
    expect(r2.valuation_explain!.depth_multiplier).toBeLessThan(1);
    expect(r3.valuation_explain!.injury_severity).toBe(3);
    expect(r3.valuation_explain!.injury_multiplier).toBeCloseTo(0.78, 5);
    expect(r3.baseline_components?.injury_component).toBeDefined();
  });
});
