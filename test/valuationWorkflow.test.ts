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
    inflation_model: "global_v1",
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
    expect(res.response.recommended_bid_note).toBe(
      "recommended_bid blends model marginal value with baseline strength for auction guidance"
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
    expect(first.recommended_bid).toBeDefined();
    expect(first.recommended_bid!).toBeGreaterThanOrEqual(
      Math.min(first.adjusted_value, first.baseline_value)
    );
    expect(first.recommended_bid!).toBeLessThanOrEqual(
      Math.max(first.adjusted_value, first.baseline_value)
    );
  });

  it("keeps recommended_bid monotonic for similarly ranked baseline players", () => {
    const localPlayers: LeanPlayer[] = [
      {
        _id: "p1",
        mlbId: 101,
        name: "Alpha",
        team: "NYY",
        position: "OF",
        adp: 10,
        tier: 1,
        value: 40,
      },
      {
        _id: "p2",
        mlbId: 102,
        name: "Bravo",
        team: "NYY",
        position: "OF",
        adp: 11,
        tier: 1,
        value: 39,
      },
    ];
    const res = executeValuationWorkflow(localPlayers, minimalInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [a, b] = res.response.valuations;
    expect(a.baseline_value).toBeGreaterThanOrEqual(b.baseline_value);
    expect(a.recommended_bid!).toBeGreaterThanOrEqual(b.recommended_bid!);
  });

  it("defaults user_team_id_used to team_1 when omitted", () => {
    const res = executeValuationWorkflow(players, minimalInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.user_team_id_used).toBe("team_1");
    expect(res.response.team_adjusted_value_note).toBe(
      "team_adjusted_value reflects team-specific need and budget relative to the league"
    );
  });

  it("team_adjusted_value applies team multipliers and preserves adjusted/recommended", () => {
    const localPlayers: LeanPlayer[] = [
      {
        _id: "u1",
        mlbId: 201,
        name: "NeedOF",
        team: "NYY",
        position: "OF",
        adp: 10,
        tier: 2,
        value: 20,
      },
      {
        _id: "u2",
        mlbId: 202,
        name: "NoNeedC",
        team: "BOS",
        position: "C",
        adp: 12,
        tier: 2,
        value: 20,
      },
    ];
    const input = minimalInput({
      user_team_id: "team_1",
      roster_slots: [
        { position: "C", count: 1 },
        { position: "OF", count: 1 },
      ],
      drafted_players: [
        {
          player_id: "999",
          name: "FilledC",
          position: "C",
          team: "NYY",
          team_id: "team_1",
          paid: 5,
        },
      ],
      budget_by_team_id: {
        team_1: 20,
        team_2: 10,
      },
    });
    const alt = { ...input, user_team_id: "team_2" as const };

    const a = executeValuationWorkflow(localPlayers, input);
    const b = executeValuationWorkflow(localPlayers, alt);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const needA = a.response.valuations.find((v) => v.player_id === "201")!;
    const cA = a.response.valuations.find((v) => v.player_id === "202")!;
    const needB = b.response.valuations.find((v) => v.player_id === "201")!;

    expect(needA.team_adjusted_value!).toBeGreaterThan(cA.team_adjusted_value!);
    expect(needA.adjusted_value).toBe(needB.adjusted_value);
    expect(needA.recommended_bid).toBe(needB.recommended_bid);
    expect(needA.team_adjusted_value).not.toBe(needB.team_adjusted_value);
    for (const row of a.response.valuations) {
      expect(row.team_adjusted_value!).toBeGreaterThanOrEqual(0);
      expect(row.team_adjusted_value!).toBeLessThanOrEqual(row.baseline_value * 1.5);
    }
  });

  it("team_adjusted_value stays monotonic for similar players", () => {
    const localPlayers: LeanPlayer[] = [
      {
        _id: "m1",
        mlbId: 301,
        name: "OF_A",
        team: "NYY",
        position: "OF",
        adp: 5,
        tier: 1,
        value: 30,
      },
      {
        _id: "m2",
        mlbId: 302,
        name: "OF_B",
        team: "NYY",
        position: "OF",
        adp: 6,
        tier: 1,
        value: 29,
      },
    ];
    const res = executeValuationWorkflow(
      localPlayers,
      minimalInput({
        user_team_id: "team_1",
        roster_slots: [{ position: "OF", count: 2 }],
        drafted_players: [],
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [x, y] = res.response.valuations;
    expect(x.adjusted_value).toBeGreaterThanOrEqual(y.adjusted_value);
    expect(x.team_adjusted_value!).toBeGreaterThanOrEqual(y.team_adjusted_value!);
  });

  it("budget pressure multiplier increases/decreases team_adjusted_value only", () => {
    const localPlayers: LeanPlayer[] = [
      {
        _id: "bp1",
        mlbId: 401,
        name: "BudgetOF",
        team: "NYY",
        position: "OF",
        adp: 10,
        tier: 2,
        value: 200,
      },
    ];
    const common = minimalInput({
      user_team_id: "team_1",
      roster_slots: [{ position: "OF", count: 1 }],
      drafted_players: [],
    });
    const highBudget = executeValuationWorkflow(localPlayers, {
      ...common,
      budget_by_team_id: { team_1: 20, team_2: 10, team_3: 10 },
    });
    const lowBudget = executeValuationWorkflow(localPlayers, {
      ...common,
      budget_by_team_id: { team_1: 8, team_2: 16, team_3: 16 },
    });
    expect(highBudget.ok && lowBudget.ok).toBe(true);
    if (!highBudget.ok || !lowBudget.ok) return;
    const hi = highBudget.response.valuations[0]!;
    const lo = lowBudget.response.valuations[0]!;
    expect(hi.adjusted_value).toBe(lo.adjusted_value);
    expect(hi.recommended_bid).toBe(lo.recommended_bid);
    expect(hi.team_adjusted_value!).toBeGreaterThan(lo.team_adjusted_value!);
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
