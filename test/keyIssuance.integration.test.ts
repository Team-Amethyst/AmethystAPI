import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import apiKeysRoutes from "../src/routes/apiKeys";
import keyIssuanceRoutes from "../src/routes/keyIssuance";
import errorHandler from "../src/middleware/errorHandler";

const MONGO_URI = process.env.KEY_ISSUANCE_INTEGRATION_MONGO_URI;

describe.skipIf(!MONGO_URI)("POST /api/keys/issue (integration)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/keys", apiKeysRoutes);
  app.use("/api/keys", keyIssuanceRoutes);
  app.use(errorHandler);

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGO_URI as string);
    }
    await mongoose.connection.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  it("creates a key via /issue with both routers mounted like production", async () => {
    const res = await request(app)
      .post("/api/keys/issue")
      .send({ owner: "integration-owner", tier: "free" })
      .expect(201);

    expect(res.body.apiKey).toMatch(/^amethyst_live_[a-f0-9]{20}\.[a-f0-9]{48}$/);
    expect(res.body.owner).toBe("integration-owner");
  });

  it("POST /api/keys still works after /issue", async () => {
    const res = await request(app)
      .post("/api/keys")
      .send({
        label: "L",
        owner: "O",
        tier: "free",
        scopes: ["valuation"],
      })
      .expect(201);
    expect(res.body.secret).toMatch(/^amethyst_live_/);
  });
});
