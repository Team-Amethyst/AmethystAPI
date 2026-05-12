import { describe, expect, it } from "vitest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";

function mk(id: number, value: number, position: string): LeanPlayer {
  return {
    _id: `x${id}`,
    mlbId: id,
    name: `P${id}`,
    team: "NYY",
    position,
    catalog_rank: id,
    catalog_tier: 1,
    value,
  };
}

function v2Input(over: Partial<NormalizedValuationInput> = {}): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: [
      { position: "C", count: 1 },
      { position: "OF", count: 3 },
    ],
    scoring_categories: [{ name: "HR", type: "batting" }],
    total_budget: 260,
    num_teams: 2,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
    inflation_model: "replacement_slots_v2",
    ...over,
  };
}

describe("valuation explainability copy (replacement_slots_v2)", () => {
  it("labels explain_v2 driver Surplus allocation and avoids misleading league inflation phrasing in why", () => {
    const players: LeanPlayer[] = [
      mk(1, 40, "OF"),
      mk(2, 30, "OF"),
      ...Array.from({ length: 25 }, (_, i) => mk(100 + i, 5, "OF")),
    ];
    const res = executeValuationWorkflow(players, v2Input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.response.valuations[0]!;
    const inflDriver = row.explain_v2?.drivers.find((d) => d.impact === row.inflation_adjustment);
    expect(inflDriver?.label).toBe("Surplus allocation");
    expect(inflDriver?.reason).toContain("surplus allocation factor");
    expect(inflDriver?.reason).toContain("surplus_basis");
    const joined = (row.why ?? []).join(" ").toLowerCase();
    expect(joined).not.toContain("league inflation");
    expect(joined).toContain("surplus allocation factor");
    expect(joined).toContain("min_bid");
  });

  it("keeps League inflation driver label for global_v1", () => {
    const players: LeanPlayer[] = [
      {
        _id: "a",
        mlbId: 1,
        name: "One",
        team: "NYY",
        position: "OF",
        catalog_rank: 5,
        catalog_tier: 1,
        value: 30,
      },
      {
        _id: "b",
        mlbId: 2,
        name: "Two",
        team: "BOS",
        position: "SP",
        catalog_rank: 40,
        catalog_tier: 2,
        value: 15,
      },
    ];
    const res = executeValuationWorkflow(players, {
      schemaVersion: "1.0.0",
      roster_slots: [{ position: "OF", count: 3 }],
      scoring_categories: [{ name: "HR", type: "batting" }],
      total_budget: 260,
      num_teams: 12,
      league_scope: "Mixed",
      drafted_players: [],
      deterministic: true,
      inflation_model: "global_v1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.response.valuations[0]!;
    const inflDriver = row.explain_v2?.drivers.find((d) => d.impact === row.inflation_adjustment);
    expect(inflDriver?.label).toBe("League inflation");
    expect((row.why ?? []).some((s) => s.toLowerCase().includes("list rescale"))).toBe(true);
  });

  it("uses surplus allocation wording in context_v2 assumptions for v2", () => {
    const players: LeanPlayer[] = [
      mk(1, 40, "OF"),
      mk(2, 30, "OF"),
      ...Array.from({ length: 25 }, (_, i) => mk(100 + i, 5, "OF")),
    ];
    const res = executeValuationWorkflow(players, v2Input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const assumptions = res.response.context_v2?.assumptions ?? [];
    expect(assumptions.some((a) => a.includes("Surplus allocation (replacement_slots_v2)"))).toBe(
      true
    );
    expect(assumptions.some((a) => a.includes("surplus allocation factor"))).toBe(true);
  });
});
