import { describe, expect, it } from "vitest";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";

function mkLean(id: number, over: Partial<LeanPlayer> = {}): LeanPlayer {
  const base: LeanPlayer = {
    _id: `ov-${id}`,
    mlbId: id,
    name: `Ov${id}`,
    team: "TST",
    position: "OF",
    catalog_rank: 35,
    catalog_tier: 3,
    value: 24,
    projection: {
      batting: { hr: 20, rbi: 70, runs: 72, sb: 6, avg: 0.272 },
    },
    age: 28,
    depthChartPosition: 1,
  };
  return { ...base, ...over };
}

function filler(): LeanPlayer[] {
  return Array.from({ length: 45 }, (_, i) =>
    mkLean(20_000 + i, {
      name: `F${i}`,
      catalog_rank: 160 + i,
      catalog_tier: 6,
    })
  );
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
    num_teams: 12,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
    seed: 3,
    inflation_model: "global_v1",
    ...over,
  };
}

describe("applyInjuryOverridesToPool", () => {
  it("last duplicate player_id wins", () => {
    const p = mkLean(1);
    const out = applyInjuryOverridesToPool([p], [
      { player_id: "1", injury_severity: 1 },
      { player_id: "1", injury_severity: 3 },
    ]);
    expect(out[0]!.injurySeverity).toBe(3);
  });

  it("severity 0 clears catalog injury", () => {
    const p = mkLean(2, { injurySeverity: 2 });
    const out = applyInjuryOverridesToPool([p], [{ player_id: "2", injury_severity: 0 }]);
    expect(out[0]!.injurySeverity).toBeUndefined();
  });
});

describe("injury_overrides request → valuation", () => {
  it("override severities 0–3 move baseline monotonically (catalog had no injury)", () => {
    const pool = [mkLean(5000), ...filler()];
    const run = (sev: number) => {
      const res = executeValuationWorkflow(pool, {
        ...baseInput(),
        injury_overrides: [{ player_id: "5000", injury_severity: sev }],
        player_ids: ["5000"],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return null;
      return res.response.valuations.find((v) => v.player_id === "5000")!;
    };
    const b0 = run(0)!;
    const b1 = run(1)!;
    const b2 = run(2)!;
    const b3 = run(3)!;
    expect(b1.baseline_value).toBeLessThan(b0.baseline_value);
    expect(b2.baseline_value).toBeLessThan(b1.baseline_value);
    expect(b3.baseline_value).toBeLessThan(b2.baseline_value);
    expect(b1.auction_value).toBeLessThanOrEqual(b0.auction_value);
    expect(b3.auction_value).toBeLessThanOrEqual(b2.auction_value);
  });

  it("override wins over missing Mongo injurySeverity", () => {
    const pool = [mkLean(5001), ...filler()];
    const plain = executeValuationWorkflow(pool, {
      ...baseInput(),
      player_ids: ["5001"],
    });
    const withOv = executeValuationWorkflow(pool, {
      ...baseInput(),
      injury_overrides: [{ player_id: "5001", injury_severity: 3 }],
      player_ids: ["5001"],
    });
    expect(plain.ok && withOv.ok).toBe(true);
    if (!plain.ok || !withOv.ok) return;
    const a = plain.response.valuations.find((v) => v.player_id === "5001")!;
    const b = withOv.response.valuations.find((v) => v.player_id === "5001")!;
    expect(b.baseline_value).toBeLessThan(a.baseline_value);
    expect(b.baseline_components?.injury_severity).toBe(3);
  });

  it("override wins over existing catalog injurySeverity", () => {
    const pool = [mkLean(5002, { injurySeverity: 1 }), ...filler()];
    const mongoOnly = executeValuationWorkflow(pool, {
      ...baseInput(),
      player_ids: ["5002"],
    });
    const overridden = executeValuationWorkflow(pool, {
      ...baseInput(),
      injury_overrides: [{ player_id: "5002", injury_severity: 3 }],
      player_ids: ["5002"],
    });
    expect(mongoOnly.ok && overridden.ok).toBe(true);
    if (!mongoOnly.ok || !overridden.ok) return;
    const m = mongoOnly.response.valuations.find((v) => v.player_id === "5002")!;
    const o = overridden.response.valuations.find((v) => v.player_id === "5002")!;
    expect(o.baseline_value).toBeLessThan(m.baseline_value);
    expect(m.baseline_components?.injury_severity).toBe(1);
    expect(o.baseline_components?.injury_severity).toBe(3);
  });

  it("valuation_explain reflects override when explain_valuation_rows is true", () => {
    const pool = [mkLean(5003), ...filler()];
    const res = executeValuationWorkflow(pool, {
      ...baseInput({
        explain_valuation_rows: true,
        injury_overrides: [{ player_id: "5003", injury_severity: 2 }],
        player_ids: ["5003"],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.response.valuations.find((v) => v.player_id === "5003")!;
    expect(row.valuation_explain?.injury_severity).toBe(2);
    expect(row.valuation_explain?.injury_multiplier).toBeCloseTo(0.92, 5);
    expect(row.valuation_explain?.injury_component).toBeDefined();
    expect(row.valuation_explain?.injury_component).toBe(
      row.baseline_components?.injury_component
    );
  });
});

describe("parseValuationRequest injury_overrides", () => {
  it("accepts flat injury_overrides", () => {
    const r = parseValuationRequest({
      roster_slots: [{ position: "OF", count: 3 }],
      scoring_categories: [{ name: "HR", type: "batting" }],
      total_budget: 260,
      drafted_players: [],
      injury_overrides: [{ player_id: "660271", injury_severity: 2 }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.normalized.injury_overrides).toEqual([
      { player_id: "660271", injury_severity: 2 },
    ]);
  });

  it("rejects injury_severity out of range", () => {
    const r = parseValuationRequest({
      roster_slots: [{ position: "OF", count: 3 }],
      scoring_categories: [{ name: "HR", type: "batting" }],
      total_budget: 260,
      drafted_players: [],
      injury_overrides: [{ player_id: "1", injury_severity: 4 }],
    });
    expect(r.success).toBe(false);
  });
});
