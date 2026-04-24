import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import keyIssuanceRoutes from "../src/routes/keyIssuance";
import errorHandler from "../src/middleware/errorHandler";

const createMock = vi.fn();

vi.mock("../src/models/ApiKey", () => ({
  default: {
    create: (...args: unknown[]) => createMock(...args),
  },
}));

describe("POST /api/keys/issue", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/keys", keyIssuanceRoutes);
  app.use(errorHandler);

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.KEY_ISSUANCE_ENABLED = "1";
    delete process.env.KEY_ISSUANCE_SECRET;
  });

  afterEach(() => {
    delete process.env.KEY_ISSUANCE_ENABLED;
    delete process.env.KEY_ISSUANCE_SECRET;
  });

  it("returns 503 when issuance is disabled", async () => {
    delete process.env.KEY_ISSUANCE_ENABLED;
    const res = await request(app)
      .post("/api/keys/issue")
      .send({ owner: "Test" })
      .expect(503);
    expect(res.body.error?.code).toBe("KEY_ISSUANCE_DISABLED");
  });

  it("returns 401 when secret is set but token is missing", async () => {
    process.env.KEY_ISSUANCE_SECRET = "expected-secret";
    const res = await request(app)
      .post("/api/keys/issue")
      .send({ owner: "Test" })
      .expect(401);
    expect(res.body.error?.code).toBe("KEY_ISSUANCE_TOKEN_MISSING");
  });

  it("returns 401 when token does not match", async () => {
    process.env.KEY_ISSUANCE_SECRET = "expected-secret";
    const res = await request(app)
      .post("/api/keys/issue")
      .set("X-Key-Issuance-Token", "wrong")
      .send({ owner: "Test" })
      .expect(401);
    expect(res.body.error?.code).toBe("KEY_ISSUANCE_TOKEN_INVALID");
  });

  it("returns 201 with apiKey when valid (no issuance secret)", async () => {
    createMock.mockResolvedValueOnce({});
    const res = await request(app)
      .post("/api/keys/issue")
      .send({ owner: "Acme Draft", tier: "free", email: "a@b.co" })
      .expect(201);

    expect(res.body.apiKey).toMatch(/^amethyst_live_[a-f0-9]{20}\.[a-f0-9]{48}$/);
    expect(res.body.owner).toBe("Acme Draft");
    expect(res.body.tier).toBe("free");
    expect(res.body.label).toBe("Acme Draft (a@b.co)");
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.owner).toBe("Acme Draft");
    expect(arg.keyHash).toBeTruthy();
    expect(arg.keyPrefix).toBeTruthy();
    expect(Array.isArray(arg.scopes)).toBe(true);
  });

  it("returns 201 when issuance secret header matches", async () => {
    process.env.KEY_ISSUANCE_SECRET = "expected-secret";
    createMock.mockResolvedValueOnce({});
    const res = await request(app)
      .post("/api/keys/issue")
      .set("X-Key-Issuance-Token", "expected-secret")
      .send({ owner: "Other" })
      .expect(201);
    expect(res.body.apiKey).toBeDefined();
  });

  it("GET /api/keys/status reflects env", async () => {
    const r1 = await request(app).get("/api/keys/status").expect(200);
    expect(r1.body.issuanceEnabled).toBe(true);
    expect(r1.body.requiresToken).toBe(false);

    process.env.KEY_ISSUANCE_SECRET = "x";
    const r2 = await request(app).get("/api/keys/status").expect(200);
    expect(r2.body.requiresToken).toBe(true);
  });
});
