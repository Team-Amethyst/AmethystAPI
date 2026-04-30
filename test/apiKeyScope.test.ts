import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { ApiKeyRequest } from "../src/middleware/apiKey";
import { requireApiKeyScope } from "../src/middleware/apiKeyScope";
import errorHandler from "../src/middleware/errorHandler";

function scopedApp(scopes: string[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as ApiKeyRequest).apiKeyScopes = scopes as ApiKeyRequest["apiKeyScopes"];
    next();
  });
  app.post("/valuation/calculate", requireApiKeyScope("valuation"), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe("requireApiKeyScope", () => {
  it("returns 403 when key lacks required scope", async () => {
    const res = await request(scopedApp(["catalog"]))
      .post("/valuation/calculate")
      .send({})
      .expect(403);
    expect(res.body.error?.code).toBe("API_KEY_SCOPE_DENIED");
  });

  it("allows request when scope is present", async () => {
    await request(scopedApp(["valuation", "catalog"]))
      .post("/valuation/calculate")
      .send({})
      .expect(200);
  });
});
