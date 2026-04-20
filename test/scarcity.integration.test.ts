import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { LeanPlayer } from "../src/types/brain";
import scarcityRoutes from "../src/routes/scarcity";

vi.mock("../src/models/Player", () => {
  const pool: LeanPlayer[] = [
    {
      _id: "1",
      mlbId: 1,
      name: "Elite SS",
      team: "NYY",
      position: "SS",
      adp: 10,
      tier: 1,
      value: 20,
    },
    {
      _id: "2",
      mlbId: 2,
      name: "Depth SS",
      team: "NYY",
      position: "SS",
      adp: 100,
      tier: 4,
      value: 5,
    },
    ...Array.from({ length: 40 }, (_, i) => ({
      _id: `of_${i}`,
      mlbId: 100 + i,
      name: `OF ${i}`,
      team: "BOS",
      position: "OF",
      adp: 120 + i,
      tier: 3,
      value: 7,
    })),
  ];
  return {
    default: {
      find: vi.fn(() => {
        const q = {
          select: vi.fn(() => q),
          lean: vi.fn(() => Promise.resolve(pool)),
        };
        return q;
      }),
    },
  };
});

describe("POST /analysis/scarcity", () => {
  const app = express();
  app.use(express.json());
  app.use("/analysis/scarcity", scarcityRoutes);

  it("returns schema v2 enrichments and selected-position explainer", async () => {
    const res = await request(app)
      .post("/analysis/scarcity")
      .send({
        drafted_players: [],
        scoring_categories: [{ name: "SV", type: "pitching" }],
        position: "SS",
        num_teams: 12,
      })
      .expect(200);

    expect(res.body.engine_contract_version).toBe("1");
    expect(res.body.schema_version).toBe("2");
    expect(res.body.calculated_at).toBe(res.body.analyzed_at);
    expect(res.body.selected_position).toBe("SS");
    expect(res.body.selected_position_explainer).toEqual(
      expect.objectContaining({
        severity: expect.stringMatching(/^(low|medium|high|critical)$/),
        urgency_score: expect.any(Number),
        message: expect.any(String),
        recommended_action: expect.any(String),
      })
    );
    const ss = res.body.positions.find((p: { position: string }) => p.position === "SS");
    expect(ss).toBeDefined();
    expect(res.body.selected_position_explainer.urgency_score).toBe(ss.scarcity_score);
    expect(Array.isArray(res.body.tier_buckets)).toBe(true);
    const ssBuckets = res.body.tier_buckets.find(
      (b: { position: string }) => b.position === "SS"
    );
    expect(ssBuckets).toBeDefined();
    expect(ssBuckets.buckets).toHaveLength(5);
    expect(ssBuckets.buckets.map((b: { tier: string }) => b.tier)).toEqual([
      "Tier 1",
      "Tier 2",
      "Tier 3",
      "Tier 4",
      "Tier 5",
    ]);
    for (const b of ssBuckets.buckets) {
      expect(typeof b.message).toBe("string");
      expect(b.message.length).toBeGreaterThan(0);
      expect(typeof b.recommended_action).toBe("string");
      expect(b.urgency_score).toBeGreaterThanOrEqual(0);
      expect(b.urgency_score).toBeLessThanOrEqual(100);
    }
  });
});
