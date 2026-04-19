import { readFileSync, readdirSync } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { LeanPlayer } from "../src/types/brain";
import { resolveDraftOrLocalCheckpoint } from "./fixturePaths";

vi.mock("../src/models/Player", () => {
  const mockPool: LeanPlayer[] = Array.from({ length: 280 }, (_, i) => ({
    _id: `db_${i}`,
    mlbId: i + 1,
    name: `Player_${i + 1}`,
    team: "NYY",
    position: "OF",
    adp: i + 1,
    tier: (i % 5) + 1,
    value: Math.max(1, 90 - (i % 45)),
  }));
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

  const files = readdirSync(checkpointsDir).filter((f) => f.endsWith(".json"));

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
      inflation_factor: expect.any(Number),
      total_budget_remaining: expect.any(Number),
      pool_value_remaining: expect.any(Number),
      players_remaining: expect.any(Number),
      calculated_at: expect.any(String),
      market_notes: expect.any(Array),
    });
    expect(Array.isArray(res.body.valuations)).toBe(true);
    if (res.body.valuations.length > 0) {
      expect(res.body.valuations[0]).toMatchObject({
        player_id: expect.any(String),
        name: expect.any(String),
        position: expect.any(String),
        baseline_value: expect.any(Number),
        adjusted_value: expect.any(Number),
        indicator: expect.stringMatching(/^(Steal|Reach|Fair Value)$/),
      });
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
    const body = JSON.parse(readFileSync(fixturePath, "utf8")) as object;

    const res = await request(app)
      .post("/valuation/calculate")
      .send(body)
      .expect(200);

    expect(res.body.engine_contract_version).toBe("1");
    expect(res.body.calculated_at).toBe("1970-01-01T00:00:00.000Z");
    expect(res.body.players_remaining).toBe(280);

    const { valuations, ...aggregateRest } = res.body;
    expect(valuations).toHaveLength(280);
    expect(aggregateRest).toMatchObject({
      engine_contract_version: "1",
      valuation_model_version: "v2-expert-manual-shape",
      calculated_at: "1970-01-01T00:00:00.000Z",
      players_remaining: 280,
      inflation_factor: expect.any(Number),
      pool_value_remaining: expect.any(Number),
      total_budget_remaining: expect.any(Number),
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
