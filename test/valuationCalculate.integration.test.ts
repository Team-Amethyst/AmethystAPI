import { readFileSync, readdirSync } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { LeanPlayer } from "../src/types/brain";
import { resolveDraftOrLocalCheckpoint } from "./fixturePaths";

/** Large enough for 2026 draft fixtures (synthetic player_id strings from the converter). */
const VALUATION_INTEGRATION_MOCK_POOL = 512;

function countUniquePlayerIdsInRequestBody(body: Record<string, unknown>): number {
  const ids = new Set<string>();
  const isInMockPool = (pid: string): boolean => {
    const n = Number(pid);
    return Number.isInteger(n) && n >= 1 && n <= VALUATION_INTEGRATION_MOCK_POOL;
  };
  const collectRows = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row != null && typeof row === "object" && "player_id" in row) {
        const pid = (row as { player_id?: unknown }).player_id;
        if (typeof pid === "string" && pid.length > 0 && isInMockPool(pid)) ids.add(pid);
      }
    }
  };
  collectRows(body.drafted_players);
  const buckets = [body.pre_draft_rosters, body.minors, body.taxi] as const;
  for (const b of buckets) {
    if (!Array.isArray(b)) continue;
    for (const bucket of b) {
      if (bucket != null && typeof bucket === "object" && "players" in bucket) {
        collectRows((bucket as { players?: unknown }).players);
      }
    }
  }
  return ids.size;
}

vi.mock("../src/models/Player", () => {
  const mockPool: LeanPlayer[] = Array.from(
    { length: 512 },
    (_, i) => ({
      _id: `db_${i}`,
      mlbId: i + 1,
      name: `Player_${i + 1}`,
      team: "NYY",
      position: "OF",
      adp: i + 1,
      tier: (i % 5) + 1,
      value: Math.max(1, 90 - (i % 45)),
    })
  );
  return {
    default: {
      find: vi.fn(() => {
        const q = {
          select: vi.fn(() => q),
          lean: vi.fn(() => Promise.resolve(mockPool)),
        };
        return q;
      }),
    },
  };
});

import { requestIdMiddleware } from "../src/middleware/requestId";
import {
  valuationCalculateHandler,
  valuationPlayerHandler,
} from "../src/routes/valuation";

const checkpointsDir = path.join(
  __dirname,
  "../test-fixtures/player-api/checkpoints"
);

describe("POST /valuation/calculate (Draft checkpoint bodies)", () => {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.post("/valuation/calculate", valuationCalculateHandler);

  const files = readdirSync(checkpointsDir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => /^pre_draft\.json$|^after_pick_\d+\.json$/.test(f));

  it.each(files)("200 and stable response shape for %s", async (file) => {
    const body = JSON.parse(
      readFileSync(path.join(checkpointsDir, file), "utf8")
    ) as object;
    const res = await request(app)
      .post("/valuation/calculate")
      .send(body)
      .expect(200);

    expect(res.body).toMatchObject({
      engine_contract_version: "1",
      inflation_model: expect.stringMatching(
        /^(global_v1|surplus_slots_v1|replacement_slots_v2)$/
      ),
      inflation_factor: expect.any(Number),
      inflation_raw: expect.any(Number),
      inflation_bounded_by: expect.stringMatching(/^(none|cap|floor)$/),
      total_budget_remaining: expect.any(Number),
      pool_value_remaining: expect.any(Number),
      players_remaining: expect.any(Number),
      calculated_at: expect.any(String),
      market_notes: expect.any(Array),
      user_team_id_used: expect.any(String),
      team_adjusted_value_note:
        "team_adjusted_value scales adjusted_value by roster need, dollars per open slot vs league peers, remaining-slot scarcity, and replacement drop-off for eligible slots",
      phase_indicator: expect.stringMatching(/^(early|mid|late)$/),
      context_v2: expect.objectContaining({
        schema_version: "2",
        calculated_at: expect.any(String),
        scope: expect.objectContaining({
          league_id: expect.any(String),
        }),
        market_summary: expect.objectContaining({
          inflation_factor: expect.any(Number),
          inflation_raw: expect.any(Number),
          inflation_bounded_by: expect.stringMatching(/^(none|cap|floor)$/),
          inflation_percent_vs_neutral: expect.any(Number),
          budget_left: expect.any(Number),
          players_left: expect.any(Number),
          model_version: expect.any(String),
        }),
        position_alerts: expect.any(Array),
      }),
    });
    expect(Array.isArray(res.body.valuations)).toBe(true);
    if (res.body.valuations.length > 0) {
      expect(res.body.valuations[0]).toMatchObject({
        player_id: expect.any(String),
        name: expect.any(String),
        position: expect.any(String),
        baseline_value: expect.any(Number),
        adjusted_value: expect.any(Number),
        recommended_bid: expect.any(Number),
        team_adjusted_value: expect.any(Number),
        edge: expect.any(Number),
        indicator: expect.stringMatching(/^(Steal|Reach|Fair Value)$/),
        explain_v2: expect.objectContaining({
          indicator: expect.stringMatching(/^(Steal|Reach|Fair Value)$/),
          auction_target: expect.any(Number),
          list_value: expect.any(Number),
          adjustments: expect.any(Object),
          drivers: expect.any(Array),
          confidence: expect.any(Number),
        }),
      });
      expect(res.body.valuations[0].recommended_bid).toBeGreaterThanOrEqual(1);
      expect(res.body.valuations[0].team_adjusted_value).toBeGreaterThanOrEqual(0);
      expect(res.body.valuations[0].edge).toBeCloseTo(
        res.body.valuations[0].team_adjusted_value -
          res.body.valuations[0].recommended_bid,
        1
      );
    }
  });
});

describe("POST /valuation/calculate — AmethystDraft BFF alignment", () => {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.post("/valuation/calculate", valuationCalculateHandler);

  const validFlatBase = {
    roster_slots: [{ position: "OF", count: 3 }],
    scoring_categories: [{ name: "HR", type: "batting" }],
    total_budget: 260,
    num_teams: 12,
    league_scope: "Mixed" as const,
    drafted_players: [] as object[],
  };

  it("echoes client X-Request-Id on success", async () => {
    const res = await request(app)
      .post("/valuation/calculate")
      .set("X-Request-Id", "draft-bff-trace-9f2a")
      .send({
        ...validFlatBase,
        schema_version: "1.0.0",
        drafted_players: [],
        deterministic: true,
        seed: 1,
      })
      .expect(200);

    expect(res.headers["x-request-id"]).toBe("draft-bff-trace-9f2a");
    expect(res.body.engine_contract_version).toBe("1");
  });

  it("400 input validation uses only { errors: [{ field, message }] }", async () => {
    const res = await request(app)
      .post("/valuation/calculate")
      .send({
        roster_slots: [],
        scoring_categories: [{ name: "HR", type: "batting" }],
        total_budget: 260,
        drafted_players: [],
      })
      .expect(400);

    expect(res.body).toEqual({
      errors: expect.any(Array),
    });
    expect(res.body.errors.length).toBeGreaterThan(0);
    for (const e of res.body.errors) {
      expect(e).toEqual({
        field: expect.any(String),
        message: expect.any(String),
      });
    }
  });

  it("accepts finalize-style flat body: dual schema keys, pre_draft_rosters array, player_ids", async () => {
    const res = await request(app)
      .post("/valuation/calculate")
      .send({
        ...validFlatBase,
        schema_version: "1.0.0",
        schemaVersion: "1.0.0",
        checkpoint: "pre_draft",
        pre_draft_rosters: [
          {
            team_id: "fantasy_team_a",
            players: [
              {
                player_id: "999",
                name: "Keeper",
                position: "OF",
                team: "NYY",
                team_id: "fantasy_team_a",
                is_keeper: true,
              },
            ],
          },
        ],
        drafted_players: [],
        deterministic: true,
        seed: 7,
        player_ids: ["1", "2", "3"],
      })
      .expect(200);

    expect(res.body.engine_contract_version).toBe("1");
    expect(res.body.recommended_bid_note).toBe(
      "recommended_bid is a phase-aware expected clearing price (early premium for stars, late depth compression toward $1–$3)"
    );
    expect(res.body.valuations).toHaveLength(3);
    expect(res.body.valuations.map((r: { player_id: string }) => r.player_id).sort()).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("budget: without budget_by_team_id, total_budget_remaining = cap − sum(paid)", async () => {
    const res = await request(app)
      .post("/valuation/calculate")
      .send({
        ...validFlatBase,
        schema_version: "1.0.0",
        deterministic: true,
        drafted_players: [
          {
            player_id: "1",
            name: "Taken",
            position: "OF",
            team: "NYY",
            team_id: "t1",
            paid: 100,
          },
        ],
      })
      .expect(200);

    expect(res.body.total_budget_remaining).toBe(260 * 12 - 100);
    expect(res.body.engine_contract_version).toBe("1");
  });

  it("passes league_id through to context_v2.scope", async () => {
    const res = await request(app)
      .post("/valuation/calculate")
      .send({
        ...validFlatBase,
        league_id: "test-league-xyz",
        schema_version: "1.0.0",
        deterministic: true,
      })
      .expect(200);
    expect(res.body.context_v2?.scope.league_id).toBe("test-league-xyz");
  });

  it("budget: with budget_by_team_id, ignores paid and sums map values", async () => {
    const res = await request(app)
      .post("/valuation/calculate")
      .send({
        ...validFlatBase,
        schema_version: "1.0.0",
        deterministic: true,
        budget_by_team_id: { t1: 80, t2: 20 },
        drafted_players: [
          {
            player_id: "1",
            name: "Taken",
            position: "OF",
            team: "NYY",
            team_id: "t1",
            paid: 9999,
          },
        ],
      })
      .expect(200);

    expect(res.body.total_budget_remaining).toBe(100);
    expect(res.body.engine_contract_version).toBe("1");
  });

  it("pre_draft.json from Draft repo (if present) or local mirror: deterministic invariant checks", async () => {
    const fixturePath = resolveDraftOrLocalCheckpoint("pre_draft.json");
    const body = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

    const res = await request(app)
      .post("/valuation/calculate")
      .send(body)
      .expect(200);

    const offBoard = countUniquePlayerIdsInRequestBody(body);
    const expectedUndrafted = VALUATION_INTEGRATION_MOCK_POOL - offBoard;

    expect(res.body.engine_contract_version).toBe("1");
    expect(res.body.calculated_at).toBe("1970-01-01T00:00:00.000Z");
    expect(res.body.players_remaining).toBe(expectedUndrafted);

    const { valuations, ...aggregateRest } = res.body;
    expect(valuations).toHaveLength(expectedUndrafted);
    expect(aggregateRest).toMatchObject({
      engine_contract_version: "1",
      inflation_model: expect.stringMatching(
        /^(global_v1|surplus_slots_v1|replacement_slots_v2)$/
      ),
      valuation_model_version: expect.stringMatching(/^amethyst-api@/),
      calculated_at: "1970-01-01T00:00:00.000Z",
      players_remaining: expectedUndrafted,
      inflation_factor: expect.any(Number),
      inflation_raw: expect.any(Number),
      inflation_bounded_by: expect.stringMatching(/^(none|cap|floor)$/),
      pool_value_remaining: expect.any(Number),
      total_budget_remaining: expect.any(Number),
      recommended_bid_note:
        "recommended_bid is a phase-aware expected clearing price (early premium for stars, late depth compression toward $1–$3)",
      team_adjusted_value_note:
        "team_adjusted_value scales adjusted_value by roster need, dollars per open slot vs league peers, remaining-slot scarcity, and replacement drop-off for eligible slots",
      phase_indicator: expect.stringMatching(/^(early|mid|late)$/),
      user_team_id_used: expect.any(String),
    });
    expect(aggregateRest.inflation_factor).toBeGreaterThanOrEqual(0.25);
    expect(aggregateRest.inflation_factor).toBeLessThanOrEqual(3);
    expect(aggregateRest.pool_value_remaining).toBeGreaterThan(0);
    expect(aggregateRest.total_budget_remaining).toBeGreaterThan(0);

    expect(valuations[0]).toMatchObject({
      player_id: expect.any(String),
      name: expect.any(String),
      baseline_value: expect.any(Number),
      adjusted_value: expect.any(Number),
      recommended_bid: expect.any(Number),
      team_adjusted_value: expect.any(Number),
      edge: expect.any(Number),
      indicator: expect.stringMatching(/^(Steal|Reach|Fair Value)$/),
      baseline_components: expect.objectContaining({
        scoring_format: expect.any(String),
        projection_component: expect.any(Number),
        scarcity_component: expect.any(Number),
      }),
    });
  });
});

describe("POST /valuation/player", () => {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.post("/valuation/calculate", valuationCalculateHandler);
  app.post("/valuation/player", valuationPlayerHandler);

  const validFlatBase = {
    roster_slots: [{ position: "OF", count: 3 }],
    scoring_categories: [{ name: "HR", type: "batting" }],
    total_budget: 260,
    num_teams: 12,
    league_scope: "Mixed" as const,
    drafted_players: [] as object[],
    deterministic: true,
    seed: 7,
  };

  it("returns a single player valuation under `player`", async () => {
    const res = await request(app)
      .post("/valuation/player")
      .send({
        ...validFlatBase,
        player_id: "1",
      })
      .expect(200);

    expect(res.body.player).toBeDefined();
    expect(res.body.player.player_id).toBe("1");
    expect(res.body.valuations).toHaveLength(1);
    expect(res.body.valuations[0].player_id).toBe("1");
    expect(res.body.context_v2.scope.player_id).toBe("1");
    expect(res.body.player.explain_v2).toBeDefined();
  });

  it("keeps league-wide totals consistent between calculate and player for same draft state", async () => {
    const body = {
      ...validFlatBase,
      player_id: "1",
      schema_version: "1.0.0",
    };
    const [calc, single] = await Promise.all([
      request(app)
        .post("/valuation/calculate")
        .send(body)
        .expect(200),
      request(app)
        .post("/valuation/player")
        .send(body)
        .expect(200),
    ]);

    expect(single.body.total_budget_remaining).toBe(calc.body.total_budget_remaining);
    expect(single.body.inflation_factor).toBeCloseTo(calc.body.inflation_factor, 5);
    expect(single.body.inflation_model).toBe(calc.body.inflation_model);
    expect(single.body.inflation_raw).toBeCloseTo(calc.body.inflation_raw, 5);
    expect(single.body.inflation_bounded_by).toBe(calc.body.inflation_bounded_by);
    expect(single.body.pool_value_remaining).toBeCloseTo(
      calc.body.pool_value_remaining,
      2
    );
    expect(single.body.players_remaining).toBe(calc.body.players_remaining);
    const calcRow = calc.body.valuations.find(
      (r: { player_id: string }) => r.player_id === "1"
    );
    expect(calcRow).toBeDefined();
    expect(single.body.player.adjusted_value).toBeCloseTo(
      calcRow!.adjusted_value,
      5
    );
    expect(single.body.context_v2.market_summary.budget_left).toBe(
      single.body.total_budget_remaining
    );
    expect(single.body.context_v2.market_summary.players_left).toBe(
      single.body.players_remaining
    );
    expect(calc.body.context_v2.market_summary.players_left).toBe(
      calc.body.players_remaining
    );
  });

  it("400 when player_id is missing", async () => {
    const res = await request(app)
      .post("/valuation/player")
      .send(validFlatBase)
      .expect(400);

    expect(res.body).toEqual({
      errors: [{ field: "player_id", message: "player_id is required" }],
    });
  });

  it("404 when player is outside current valuation pool", async () => {
    const res = await request(app)
      .post("/valuation/player")
      .send({
        ...validFlatBase,
        player_id: "999999",
      })
      .expect(404);

    expect(res.body).toEqual({
      errors: [
        { field: "player_id", message: "Player not found in valuation pool" },
      ],
    });
  });
});
