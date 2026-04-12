import { readFileSync, readdirSync } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { LeanPlayer } from "../src/types/brain";

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
      find: vi.fn(() => ({
        lean: vi.fn(() => Promise.resolve(mockPool)),
      })),
    },
  };
});

import { valuationCalculateHandler } from "../src/routes/valuation";

const checkpointsDir = path.join(
  __dirname,
  "../test-fixtures/player-api/checkpoints"
);

describe("POST /valuation/calculate (Draft checkpoint bodies)", () => {
  const app = express();
  app.use(express.json());
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
      inflation_factor: expect.any(Number),
      total_budget_remaining: expect.any(Number),
      pool_value_remaining: expect.any(Number),
      players_remaining: expect.any(Number),
      calculated_at: expect.any(String),
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
