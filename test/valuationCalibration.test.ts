import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";

const fixturePath = path.join(
  __dirname,
  "../test-fixtures/valuation-calibration/manual-benchmark.json"
);

const pool: LeanPlayer[] = [
  {
    _id: "3001",
    mlbId: 3001,
    name: "Manual Top",
    team: "ATL",
    position: "OF",
    adp: 3,
    tier: 1,
    value: 48,
    projection: {
      batting: { hr: 40, rbi: 112, runs: 105, sb: 20, avg: 0.302, obp: 0.39 },
    },
  },
  {
    _id: "3002",
    mlbId: 3002,
    name: "Ace Arm",
    team: "SEA",
    position: "SP",
    adp: 6,
    tier: 1,
    value: 41,
    projection: {
      pitching: { wins: 15, strikeouts: 235, saves: 0, era: 3.02, whip: 1.04 },
    },
  },
  {
    _id: "2001",
    mlbId: 2001,
    name: "Cheap Keeper",
    team: "LAD",
    position: "SP",
    adp: 50,
    tier: 3,
    value: 18,
    projection: {
      pitching: { wins: 9, strikeouts: 140, saves: 0, era: 3.8, whip: 1.2 },
    },
  },
  {
    _id: "1001",
    mlbId: 1001,
    name: "Keeper Star",
    team: "NYY",
    position: "OF",
    adp: 14,
    tier: 2,
    value: 32,
    projection: {
      batting: { hr: 29, rbi: 92, runs: 80, sb: 12, avg: 0.279, obp: 0.36 },
    },
  },
];

describe("valuation calibration fixture", () => {
  it("stays inside benchmark ranges and explainability fields", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      input: NormalizedValuationInput;
      expectations: {
        top_player_id: string;
        min_inflation_factor: number;
        max_inflation_factor: number;
      };
    };
    const res = executeValuationWorkflow(pool, fixture.input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.response.inflation_factor).toBeGreaterThanOrEqual(
      fixture.expectations.min_inflation_factor
    );
    expect(res.response.inflation_factor).toBeLessThanOrEqual(
      fixture.expectations.max_inflation_factor
    );
    expect(res.response.valuations[0]?.player_id).toBe(
      fixture.expectations.top_player_id
    );
    expect(res.response.valuations[0]?.baseline_components).toBeDefined();
  });
});
