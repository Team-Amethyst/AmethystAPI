import { describe, expect, it } from "vitest";
import { executeValuationWorkflow, resolveScoringMode } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";

const players: LeanPlayer[] = [
  {
    _id: "a",
    mlbId: 1,
    name: "One",
    team: "NYY",
    position: "OF",
    adp: 5,
    tier: 1,
    value: 30,
  },
  {
    _id: "b",
    mlbId: 2,
    name: "Two",
    team: "BOS",
    position: "SP",
    adp: 40,
    tier: 2,
    value: 15,
  },
];

function minimalInput(
  over: Partial<NormalizedValuationInput> = {}
): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: [{ position: "OF", count: 3 }],
    scoring_categories: [{ name: "HR", type: "batting" }],
    total_budget: 260,
    num_teams: 12,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
    ...over,
  };
}

describe("resolveScoringMode", () => {
  it("returns points for scoring_format points", () => {
    expect(
      resolveScoringMode(minimalInput({ scoring_format: "points" }))
    ).toBe("points");
  });

  it("returns rotisserie_categories for 5x5 and 6x6", () => {
    expect(
      resolveScoringMode(minimalInput({ scoring_format: "5x5" }))
    ).toBe("rotisserie_categories");
    expect(
      resolveScoringMode(minimalInput({ scoring_format: "6x6" }))
    ).toBe("rotisserie_categories");
  });

  it("defaults to rotisserie_categories when scoring_format omitted", () => {
    expect(resolveScoringMode(minimalInput())).toBe("rotisserie_categories");
  });
});

describe("executeValuationWorkflow", () => {
  it("returns valid response for normal pool", () => {
    const res = executeValuationWorkflow(players, minimalInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.valuations).toHaveLength(2);
    expect(res.response.players_remaining).toBe(2);
  });

  it("handles empty player pool", () => {
    const res = executeValuationWorkflow([], minimalInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.players_remaining).toBe(0);
    expect(res.response.valuations).toHaveLength(0);
  });

  it("includes engine_contract_version on success", () => {
    const res = executeValuationWorkflow(players, minimalInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.engine_contract_version).toBe("1");
  });

  it("adds explainability metadata on valuation rows", () => {
    const res = executeValuationWorkflow(players, minimalInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.valuation_model_version).toMatch(/^amethyst-api@/);
    expect(res.response.valuations[0].baseline_components).toBeDefined();
    expect(Array.isArray(res.response.market_notes)).toBe(true);
    expect(res.response.market_notes!.length).toBeGreaterThan(0);
    expect(Array.isArray(res.response.valuations[0].why)).toBe(true);
    expect(res.response.valuations[0].why!.length).toBeGreaterThan(0);
    expect(res.response.context_v2?.schema_version).toBe("2");
    expect(res.response.context_v2?.market_summary.players_left).toBe(
      res.response.players_remaining
    );
    const first = res.response.valuations[0];
    expect(first.explain_v2).toBeDefined();
    expect(first.explain_v2?.auction_target).toBe(first.adjusted_value);
    expect(first.explain_v2?.list_value).toBe(first.baseline_value);
    const adj = first.explain_v2!.adjustments;
    const delta = Number((first.adjusted_value - first.baseline_value).toFixed(2));
    const sum = Number((adj.scarcity + adj.inflation + adj.other).toFixed(2));
    expect(Math.abs(delta - sum)).toBeLessThanOrEqual(0.02);
    const impacts = first.explain_v2!.drivers.map((d) => Math.abs(d.impact));
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    const alerts = res.response.context_v2?.position_alerts ?? [];
    const sevRank = { critical: 4, high: 3, medium: 2, low: 1 };
    for (let i = 1; i < alerts.length; i++) {
      const prev = alerts[i - 1];
      const cur = alerts[i];
      const prevRank = sevRank[prev.severity];
      const curRank = sevRank[cur.severity];
      expect(prevRank >= curRank).toBe(true);
      if (prevRank === curRank) {
        expect(prev.urgency_score >= cur.urgency_score).toBe(true);
      }
    }
    for (const text of first.why ?? []) {
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it("when budget_by_team_id is set, ignores paid on drafted_players", () => {
    const highPaid = minimalInput({
      drafted_players: [
        {
          player_id: "1",
          name: "Taken",
          position: "OF",
          team: "NYY",
          team_id: "team_1",
          paid: 999,
        },
      ],
      budget_by_team_id: {
        team_1: 200,
        team_2: 200,
      },
    });
    const lowPaid = {
      ...highPaid,
      drafted_players: [
        {
          ...highPaid.drafted_players[0],
          paid: 1,
        },
      ],
    };
    const a = executeValuationWorkflow(players, highPaid);
    const b = executeValuationWorkflow(players, lowPaid);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.response.total_budget_remaining).toBe(
      b.response.total_budget_remaining
    );
    expect(a.response.inflation_factor).toBe(b.response.inflation_factor);
    expect(a.response.total_budget_remaining).toBe(400);
  });

  it("accounts for pre_draft/minors/taxi spend and drafted ids in v2 budget/pool", () => {
    const withKeepers = executeValuationWorkflow(
      players,
      minimalInput({
        pre_draft_rosters: {
          t1: [
            {
              player_id: "1",
              name: "Keeper",
              position: "OF",
              team: "NYY",
              team_id: "t1",
              keeper_cost: 20,
            },
          ],
        },
        minors: [
          {
            team_id: "t1",
            players: [
              {
                player_id: "2",
                name: "Minor",
                position: "SP",
                team: "BOS",
                team_id: "t1",
                paid: 5,
              },
            ],
          },
        ],
      })
    );
    expect(withKeepers.ok).toBe(true);
    if (!withKeepers.ok) return;
    expect(withKeepers.response.total_budget_remaining).toBe(260 * 12 - 25);
    expect(withKeepers.response.players_remaining).toBe(0);
  });

  it("prioritizes selected player position in market_notes for player-scoped responses", () => {
    const res = executeValuationWorkflow(players, minimalInput(), { playerId: "2" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.context_v2?.scope.player_id).toBe("2");
    expect(res.response.context_v2?.scope.position).toBe("SP");
    expect(
      (res.response.market_notes ?? []).some((n) => n.startsWith("SP:"))
    ).toBe(true);
  });
});
