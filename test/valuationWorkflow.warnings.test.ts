import { describe, expect, it, vi } from "vitest";
import { ENGINE_CONTRACT_VERSION } from "../src/lib/engineContract";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";

vi.mock("../src/services/inflationEngine", () => ({
  calculateInflation: vi.fn(() => ({
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    inflation_factor: Number.NaN,
    total_budget_remaining: 0,
    pool_value_remaining: 0,
    players_remaining: 0,
    valuations: [],
    calculated_at: "1970-01-01T00:00:00.000Z",
  })),
}));

import { executeValuationWorkflow } from "../src/services/valuationWorkflow";

function minimalInput(): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: [{ position: "OF", count: 3 }],
    scoring_categories: [{ name: "HR", type: "batting" }],
    total_budget: 260,
    num_teams: 12,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
  };
}

describe("executeValuationWorkflow validation merge", () => {
  it("fails closed when inflation output is invalid", () => {
    const res = executeValuationWorkflow([] as LeanPlayer[], minimalInput());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.length).toBeGreaterThan(0);
    expect(res.issues.some((w) => w.includes("inflation_factor"))).toBe(true);
  });
});
