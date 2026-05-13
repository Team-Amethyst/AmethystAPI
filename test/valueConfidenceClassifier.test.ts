import { describe, expect, it } from "vitest";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";
import type { ValuationResponse, ValuedPlayer } from "../src/types/valuation";
import {
  buildHeadlinePlayerChecks,
  collectSuspiciousValueFindings,
  findDuplicateMlbIds,
  playerIdLooksLikeMongoObjectId,
  resolveHeadlinePlayerFromPool,
} from "../src/lib/valueConfidence/classifier";

function mkRow(p: Partial<ValuedPlayer> & Pick<ValuedPlayer, "player_id" | "name">): ValuedPlayer {
  return {
    catalog_rank: 1,
    catalog_tier: 1,
    baseline_rank: 1,
    auction_rank: p.auction_rank ?? 1,
    baseline_tier: 1,
    auction_tier: 1,
    baseline_value: p.baseline_value ?? 10,
    auction_value: p.auction_value ?? 10,
    adjusted_value: p.auction_value ?? 10,
    indicator: "Fair Value",
    inflation_factor: 2,
    position: p.position ?? "OF",
    team: "NYY",
    ...p,
  } as ValuedPlayer;
}

function mkResponse(rows: ValuedPlayer[], over: Partial<ValuationResponse> = {}): ValuationResponse {
  return {
    engine_contract_version: "test",
    inflation_model: "replacement_slots_v2",
    inflation_factor: 2,
    inflation_raw: 2,
    inflation_bounded_by: "none",
    total_budget_remaining: 100,
    pool_value_remaining: 100,
    players_remaining: rows.length,
    valuations: rows,
    calculated_at: new Date().toISOString(),
    draftable_player_ids: rows.map((r) => r.player_id),
    draftable_pool_size: rows.length,
    ...over,
  } as ValuationResponse;
}

function mkInput(over: Partial<NormalizedValuationInput> = {}): NormalizedValuationInput {
  return {
    schemaVersion: "1.0.0",
    roster_slots: [],
    scoring_categories: [
      { name: "R", type: "batting" },
      { name: "HR", type: "batting" },
      { name: "RBI", type: "batting" },
      { name: "SB", type: "batting" },
      { name: "AVG", type: "batting" },
      { name: "W", type: "pitching" },
      { name: "SV", type: "pitching" },
      { name: "ERA", type: "pitching" },
      { name: "WHIP", type: "pitching" },
      { name: "K", type: "pitching" },
    ],
    total_budget: 260,
    num_teams: 12,
    league_scope: "Mixed",
    drafted_players: [],
    deterministic: true,
    ...over,
  };
}

describe("valueConfidence classifier", () => {
  it("flags market_adp elite with tiny auction_value", () => {
    const row = mkRow({
      player_id: "1",
      name: "Star",
      market_adp: 12,
      auction_value: 3,
      auction_rank: 50,
    });
    const poolById = new Map<string, LeanPlayer>();
    const f = collectSuspiciousValueFindings({
      scenarioId: "t",
      input: mkInput(),
      response: mkResponse([row]),
      poolById,
      topSpAuction: 40,
      draftedPickCount: 0,
    });
    expect(f.some((x) => x.rule_id === "market_adp_top15_auction_le_3")).toBe(true);
  });

  it("does not flag market_adp50 rank rule when auction dollars remain healthy", () => {
    const row = mkRow({
      player_id: "1",
      name: "X",
      market_adp: 40,
      auction_rank: 400,
      auction_value: 12,
    });
    const f = collectSuspiciousValueFindings({
      scenarioId: "t",
      input: mkInput(),
      response: mkResponse([row]),
      poolById: new Map(),
      topSpAuction: 20,
      draftedPickCount: 0,
    });
    expect(f.some((x) => x.rule_id === "market_adp50_auction_rank_gt200_cheap")).toBe(false);
  });

  it("skips high-baseline floor rule after deep draft scenarios", () => {
    const row = mkRow({
      player_id: "2",
      name: "Weird",
      market_adp: 45,
      baseline_value: 58,
      auction_value: 0.5,
    });
    const f = collectSuspiciousValueFindings({
      scenarioId: "t",
      input: mkInput(),
      response: mkResponse([row]),
      poolById: new Map(),
      topSpAuction: 40,
      draftedPickCount: 90,
    });
    expect(f.some((x) => x.rule_id === "market_adp_high_baseline_auction_le1")).toBe(false);
  });

  it("flags baseline high but auction at floor", () => {
    const row = mkRow({
      player_id: "2",
      name: "Weird",
      market_adp: 45,
      baseline_value: 58,
      auction_value: 0.5,
    });
    const f = collectSuspiciousValueFindings({
      scenarioId: "t",
      input: mkInput(),
      response: mkResponse([row]),
      poolById: new Map(),
      topSpAuction: 40,
      draftedPickCount: 0,
    });
    expect(f.some((x) => x.rule_id === "market_adp_high_baseline_auction_le1")).toBe(true);
  });

  it("detects duplicate mlbId in pool", () => {
    const pool: LeanPlayer[] = [
      { _id: "a", mlbId: 100, name: "A", team: "NYY", position: "OF", catalog_rank: 1, catalog_tier: 1, value: 10 },
      { _id: "b", mlbId: 100, name: "B", team: "BOS", position: "OF", catalog_rank: 2, catalog_tier: 1, value: 9 },
    ];
    expect(findDuplicateMlbIds(pool)).toEqual([{ mlbId: 100, count: 2 }]);
  });

  it("playerIdLooksLikeMongoObjectId accepts 24-hex only", () => {
    expect(playerIdLooksLikeMongoObjectId("507f1f77bcf86cd799439011")).toBe(true);
    expect(playerIdLooksLikeMongoObjectId("660271")).toBe(false);
  });

  it("flags ObjectId-shaped player_id", () => {
    const oid = "507f1f77bcf86cd799439011";
    const row = mkRow({ player_id: oid, name: "X", auction_value: 20 });
    const f = collectSuspiciousValueFindings({
      scenarioId: "t",
      input: mkInput(),
      response: mkResponse([row]),
      poolById: new Map(),
      topSpAuction: 30,
      draftedPickCount: 0,
    });
    expect(f.some((x) => x.rule_id === "objectid_like_player_id" && x.player_id === oid)).toBe(true);
  });

  it("resolveHeadlinePlayerFromPool matches substring", () => {
    const pool: LeanPlayer[] = [
      {
        _id: "1",
        mlbId: 660271,
        name: "Shohei Ohtani",
        team: "LAD",
        position: "DH",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 50,
      },
    ];
    const hit = resolveHeadlinePlayerFromPool(pool, { label: "Ohtani", needles: ["ohtani"] });
    expect(hit?.player_id).toBe("660271");
  });

  it("does not flag top_sp_below_band when many picks are drafted", () => {
    const rows: ValuedPlayer[] = [
      mkRow({ player_id: "1", name: "A", position: "SP", auction_value: 1 }),
    ];
    const f = collectSuspiciousValueFindings({
      scenarioId: "deep",
      input: mkInput(),
      response: mkResponse(rows),
      poolById: new Map(),
      topSpAuction: 1,
      draftedPickCount: 120,
    });
    expect(f.some((x) => x.rule_id === "top_sp_below_band")).toBe(false);
  });

  it("resolveHeadlinePlayerFromPool prefers higher catalog value on collisions", () => {
    const pool: LeanPlayer[] = [
      {
        _id: "a",
        mlbId: 111,
        name: "Andrew Alvarez",
        team: "LAD",
        position: "P",
        catalog_rank: 400,
        catalog_tier: 3,
        value: 12,
      },
      {
        _id: "b",
        mlbId: 670541,
        name: "Yordan Alvarez",
        team: "HOU",
        position: "DH",
        catalog_rank: 5,
        catalog_tier: 1,
        value: 48,
      },
    ];
    const hit = resolveHeadlinePlayerFromPool(pool, {
      label: "Alvarez",
      needles: ["yordan", "alvarez"],
      match: "all",
    });
    expect(hit?.player_id).toBe("670541");
  });

  it("buildHeadlinePlayerChecks marks missing and ok", () => {
    const pool: LeanPlayer[] = [
      {
        _id: "1",
        mlbId: 1,
        name: "Aaron Judge",
        team: "NYY",
        position: "OF",
        catalog_rank: 2,
        catalog_tier: 1,
        value: 40,
      },
    ];
    const vals: ValuedPlayer[] = [
      mkRow({
        player_id: "1",
        name: "Aaron Judge",
        auction_value: 40,
        auction_rank: 3,
        baseline_value: 38,
      }),
    ];
    const checks = buildHeadlinePlayerChecks(pool, vals);
    const judge = checks.find((c) => c.label === "Judge");
    const ohtani = checks.find((c) => c.label === "Ohtani");
    expect(judge?.status).toBe("ok");
    expect(judge?.auction_value).toBe(40);
    expect(ohtani?.status).toBe("missing_from_pool");
  });
});
