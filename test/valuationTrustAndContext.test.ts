import { describe, expect, it } from "vitest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { DraftedPlayer, LeanPlayer, NormalizedValuationInput } from "../src/types/brain";

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

function baseInput(
  over: Partial<NormalizedValuationInput> = {}
): NormalizedValuationInput {
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

describe("valuation trust / explainability", () => {
  it("omits valuation_explain on rows when explain_valuation_rows is omitted", () => {
    const players: LeanPlayer[] = [
      mk(1, 40, "OF"),
      mk(2, 30, "OF"),
      ...Array.from({ length: 20 }, (_, i) => mk(50 + i, 5, "OF")),
    ];
    const res = executeValuationWorkflow(players, baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const v of res.response.valuations) {
      expect(v.valuation_explain).toBeUndefined();
    }
  });

  it("emits thin-pool valuation_context_warnings when eligible pool < remaining roster slots", () => {
    const players: LeanPlayer[] = [
      mk(1, 40, "OF"),
      mk(2, 35, "OF"),
      mk(3, 30, "C"),
      ...Array.from({ length: 12 }, (_, i) => mk(10 + i, 8 - i * 0.2, "OF")),
    ];
    const ids = players.slice(0, 6).map((p) => String(p.mlbId));
    const res = executeValuationWorkflow(
      players,
      baseInput({ eligible_player_ids: ids })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.valuation_context?.eligible_pool_size).toBe(6);
    expect(res.response.valuation_context_warnings?.length).toBeGreaterThan(0);
    expect(
      res.response.valuation_context_warnings!.some((w) =>
        w.includes("Eligible catalog pool is smaller than empty roster slots")
      )
    ).toBe(true);
  });

  it("warns on small custom eligible_player_ids universe", () => {
    const players: LeanPlayer[] = Array.from({ length: 80 }, (_, i) =>
      mk(500 + i, 20 - i * 0.1, "OF")
    );
    const ids = players.slice(0, 40).map((p) => String(p.mlbId));
    const res = executeValuationWorkflow(
      players,
      baseInput({ eligible_player_ids: ids })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(
      res.response.valuation_context_warnings?.some((w) =>
        w.includes("Custom eligible_player_ids produced a small universe")
      )
    ).toBe(true);
  });

  it("attaches valuation_explain when explain_valuation_rows is true", () => {
    const players: LeanPlayer[] = [
      mk(1, 40, "OF"),
      mk(2, 30, "OF"),
      ...Array.from({ length: 25 }, (_, i) => mk(100 + i, 5, "OF")),
    ];
    const res = executeValuationWorkflow(
      players,
      baseInput({ explain_valuation_rows: true })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.response.valuations.find((v) => v.player_id === "1");
    expect(row?.valuation_explain).toBeDefined();
    expect(row!.valuation_explain!.effective_positions.length).toBeGreaterThan(0);
    expect(row!.valuation_explain!.pool_size).toBe(players.length);
    expect(row!.valuation_explain!.roster_demand_slots).toBe(
      res.response.remaining_slots
    );
  });

  it("recommended_bid_soft_cap_ratio clamps bids versus auction_value", () => {
    const players: LeanPlayer[] = [
      mk(1, 50, "OF"),
      mk(2, 40, "OF"),
      ...Array.from({ length: 30 }, (_, i) => mk(200 + i, 4, "OF")),
    ];
    const uncapped = executeValuationWorkflow(players, baseInput());
    const capped = executeValuationWorkflow(
      players,
      baseInput({ recommended_bid_soft_cap_ratio: 1.05 })
    );
    expect(uncapped.ok && capped.ok).toBe(true);
    if (!uncapped.ok || !capped.ok) return;
    const starUnc = uncapped.response.valuations.find((v) => v.player_id === "1")!;
    const starCap = capped.response.valuations.find((v) => v.player_id === "1")!;
    expect(starUnc.auction_value).toBeCloseTo(starCap.auction_value, 4);
    expect(starCap.recommended_bid!).toBeLessThanOrEqual(
      starCap.auction_value * 1.05 + 0.02
    );
    if (starUnc.recommended_bid! > starUnc.auction_value * 1.05 + 0.5) {
      expect(starCap.recommended_bid!).toBeLessThan(starUnc.recommended_bid!);
    }
  });

  it("asymmetric pre_draft keepers: auction_value matches across user_team_id while team_adjusted_value can diverge", () => {
    const keepers: DraftedPlayer[] = Array.from({ length: 6 }, (_, i) => ({
      player_id: `keeper_${i}`,
      name: `K${i}`,
      position: "OF",
      team: "NYY",
      team_id: "team_1",
    }));
    const players: LeanPlayer[] = [
      mk(1, 48, "OF"),
      mk(2, 42, "OF"),
      mk(3, 36, "C"),
      ...Array.from({ length: 35 }, (_, i) => mk(300 + i, 6 - i * 0.05, "OF")),
    ];
    const pre = { team_1: keepers.map((k) => ({ ...k })) };
    const inp = baseInput({ pre_draft_rosters: pre });
    const a = executeValuationWorkflow(players, { ...inp, user_team_id: "team_1" });
    const b = executeValuationWorkflow(players, { ...inp, user_team_id: "team_2" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const ra = a.response.valuations.find((v) => v.player_id === "1")!;
    const rb = b.response.valuations.find((v) => v.player_id === "1")!;
    expect(ra.auction_value).toBeCloseTo(rb.auction_value, 4);
    expect(ra.team_adjusted_value).toBeDefined();
    expect(rb.team_adjusted_value).toBeDefined();
    expect(ra.team_adjusted_value).not.toBeCloseTo(rb.team_adjusted_value!, 2);
  });
});
