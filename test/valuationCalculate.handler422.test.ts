import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ENGINE_CONTRACT_VERSION } from "../src/lib/engineContract";
vi.mock("../src/models/Player", () => ({
  default: {
    find: vi.fn(() => ({
      lean: vi.fn(() =>
        Promise.resolve([
          {
            _id: "a",
            mlbId: 1,
            name: "One",
            team: "NYY",
            position: "OF",
            adp: 1,
            tier: 1,
            value: 10,
          },
        ])
      ),
    })),
  },
}));

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

import { requestIdMiddleware } from "../src/middleware/requestId";
import { valuationCalculateHandler } from "../src/routes/valuation";

describe("valuationCalculateHandler output validation", () => {
  it("returns 422 when post-calculation checks fail", async () => {
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.post("/valuation/calculate", valuationCalculateHandler);

    const res = await request(app)
      .post("/valuation/calculate")
      .send({
        roster_slots: [{ position: "OF", count: 3 }],
        scoring_categories: [{ name: "HR", type: "batting" }],
        total_budget: 260,
        drafted_players: [],
        deterministic: true,
      });

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(res.body.valuations).toBeUndefined();
  });
});
