import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { LeanPlayer } from "../src/types/brain";

vi.mock("../src/models/Player", () => ({
  default: {
    find: vi.fn(() => {
      const q = {
        select: vi.fn(() => q),
        lean: vi.fn(() =>
          Promise.resolve([
            {
              _id: "x",
              mlbId: 660271,
              name: "Shohei",
              team: "LAD",
              position: "DH",
              value: 55,
              tier: 1,
              adp: 1,
            },
          ] as LeanPlayer[])
        ),
      };
      return q;
    }),
  },
}));

import { requestIdMiddleware } from "../src/middleware/requestId";
import catalogRoutes from "../src/routes/catalog";

describe("POST /catalog/batch-values", () => {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/catalog", catalogRoutes);

  it("returns rows for known mlbIds", async () => {
    const res = await request(app)
      .post("/catalog/batch-values")
      .send({ player_ids: ["660271"], league_scope: "Mixed" })
      .expect(200);

    expect(res.body.players).toHaveLength(1);
    expect(res.body.engine_contract_version).toBe("1");
    expect(res.body.players[0]).toMatchObject({
      player_id: "660271",
      name: "Shohei",
      value: 55,
      tier: 1,
      adp: 1,
    });
  });

  it("returns 400 with field errors for invalid body", async () => {
    const res = await request(app)
      .post("/catalog/batch-values")
      .send({ player_ids: [] })
      .expect(400);

    expect(res.body.errors).toBeDefined();
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors[0]).toMatchObject({
      field: expect.any(String),
      message: expect.any(String),
    });
  });
});
