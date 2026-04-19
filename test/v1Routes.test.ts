import express from "express";
import request from "supertest";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { LeanPlayer } from "../src/types/brain";
import { requestIdMiddleware } from "../src/middleware/requestId";
import {
  valuationCalculateHandler,
  valuationPlayerHandler,
} from "../src/routes/valuation";

vi.mock("../src/models/Player", () => {
  const mockPool: LeanPlayer[] = Array.from({ length: 40 }, (_, i) => ({
    _id: `db_${i}`,
    mlbId: i + 1,
    name: `Player_${i + 1}`,
    team: "NYY",
    position: "OF",
    adp: i + 1,
    tier: (i % 5) + 1,
    value: Math.max(1, 40 - (i % 20)),
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

describe("/v1/valuation parity", () => {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.post("/v1/valuation/calculate", valuationCalculateHandler);
  app.post("/v1/valuation/player", valuationPlayerHandler);

  const body = JSON.parse(
    readFileSync(
      path.join(__dirname, "../test-fixtures/player-api/checkpoints/pre_draft.json"),
      "utf8"
    )
  ) as object;

  it("POST /v1/valuation/calculate matches legacy success shape + explainability", async () => {
    const res = await request(app).post("/v1/valuation/calculate").send(body).expect(200);
    expect(res.body.engine_contract_version).toBe("1");
    expect(Array.isArray(res.body.market_notes)).toBe(true);
    if (res.body.valuations.length > 0) {
      expect(Array.isArray(res.body.valuations[0].why)).toBe(true);
    }
  });

  it("POST /v1/valuation/player returns player envelope", async () => {
    const res = await request(app)
      .post("/v1/valuation/player")
      .send({ ...body, player_id: "1" })
      .expect(200);
    expect(res.body.player).toBeDefined();
    expect(res.body.player.player_id).toBe("1");
    expect(Array.isArray(res.body.market_notes)).toBe(true);
  });
});
