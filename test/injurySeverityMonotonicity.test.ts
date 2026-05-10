import { describe, expect, it } from "vitest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";
import { injuryMultiplier } from "../src/services/baselineInjuryAdjustments";

function mkLean(id: number, injurySeverity: number | undefined): LeanPlayer {
  return {
    _id: `inj-mono-${id}`,
    mlbId: id,
    name: `InjMono${id}`,
    team: "TST",
    position: "OF",
    catalog_rank: 30,
    catalog_tier: 3,
    value: 22,
    projection: {
      batting: { hr: 22, rbi: 72, runs: 75, sb: 8, avg: 0.275 },
    },
    age: 28,
    depthChartPosition: 1,
    ...(injurySeverity !== undefined ? { injurySeverity } : {}),
  };
}

function filler(): LeanPlayer[] {
  return Array.from({ length: 40 }, (_, i) =>
    mkLean(10_000 + i, undefined)
  ).map((p, i) => ({
    ...p,
    mlbId: 10_000 + i,
    catalog_rank: 150 + i,
    catalog_tier: 6,
    name: `Filler${i}`,
  }));
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
    seed: 7,
    inflation_model: "global_v1",
    ...over,
  };
}

describe("injurySeverity catalog → baseline → auction", () => {
  it("uses canonical multipliers for severities 0–3", () => {
    expect(injuryMultiplier(0)).toBe(1);
    expect(injuryMultiplier(1)).toBeCloseTo(0.985, 10);
    expect(injuryMultiplier(2)).toBeCloseTo(0.92, 10);
    expect(injuryMultiplier(3)).toBeCloseTo(0.78, 10);
  });

  it("strictly lowers baseline_value as severity increases (same player profile)", () => {
    const poolBase = filler();
    const run = (sev: number | undefined) => {
      const target = mkLean(5000, sev);
      const res = executeValuationWorkflow([target, ...poolBase], baseInput());
      expect(res.ok).toBe(true);
      if (!res.ok) return null;
      const row = res.response.valuations.find((v) => v.player_id === "5000");
      return row;
    };

    const b0 = run(undefined);
    const b0b = run(0);
    const b1 = run(1);
    const b2 = run(2);
    const b3 = run(3);
    expect(b0 && b0b && b1 && b2 && b3).toBeTruthy();
    if (!b0 || !b0b || !b1 || !b2 || !b3) return;

    expect(b0.baseline_value).toBe(b0b.baseline_value);
    expect(b1.baseline_value).toBeLessThan(b0.baseline_value);
    expect(b2.baseline_value).toBeLessThan(b1.baseline_value);
    expect(b3.baseline_value).toBeLessThan(b2.baseline_value);

    expect(b1.auction_value).toBeLessThanOrEqual(b0.auction_value);
    expect(b2.auction_value).toBeLessThanOrEqual(b1.auction_value);
    expect(b3.auction_value).toBeLessThanOrEqual(b2.auction_value);
  });

  it("includes injury explain fields on baseline_components and valuation_explain when requested", () => {
    const target = mkLean(5001, 2);
    const res = executeValuationWorkflow(
      [target, ...filler()],
      baseInput({ explain_valuation_rows: true, player_ids: ["5001"] })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.response.valuations.find((v) => v.player_id === "5001");
    expect(row?.baseline_components?.injury_severity).toBe(2);
    expect(row?.baseline_components?.injury_multiplier).toBeCloseTo(0.92, 5);
    expect(row?.baseline_components?.injury_component).toBeDefined();
    expect(row?.baseline_components?.injury_component).toBeLessThan(0);
    const ex = row?.valuation_explain;
    expect(ex?.injury_severity).toBe(2);
    expect(ex?.injury_multiplier).toBeCloseTo(0.92, 5);
    expect(ex?.injury_component).toBe(row?.baseline_components?.injury_component);
  });
});
