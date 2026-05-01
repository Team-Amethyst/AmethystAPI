import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import usageRoutes from "../src/routes/usage";
import errorHandler from "../src/middleware/errorHandler";

const findOneMock = vi.fn();
const findByIdMock = vi.fn();

vi.mock("../src/models/ApiKey", () => ({
  default: {
    findOne: (...args: unknown[]) => findOneMock(...args),
  },
}));

vi.mock("../src/models/DeveloperAccount", () => ({
  default: {
    findById: (...args: unknown[]) => findByIdMock(...args),
  },
}));

const validKey = `amethyst_live_${"a".repeat(20)}.${"b".repeat(48)}`;

describe("GET /api/usage", () => {
  const app = express();
  app.use("/api/usage", usageRoutes);
  app.use(errorHandler);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when x-api-key is missing", async () => {
    findOneMock.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    const res = await request(app).get("/api/usage").expect(401);
    expect(res.body.error?.code).toBe("API_KEY_MISSING");
  });

  it("returns label, keyPrefix, and developerAccount when linked", async () => {
    findOneMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        owner: "Owner Name",
        label: "CI key",
        email: "issued+deadbeef@amethyst-api.local",
        developerAccountId: "507f1f77bcf86cd799439011",
        tier: "free",
        scopes: ["valuation"],
        keyPrefix: "amethyst_live_abc",
        usageCount: 3,
        lastUsed: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: null,
        isActive: true,
      }),
    });
    findByIdMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        displayName: "Acme Draft",
        organization: "Acme Org",
        contactEmail: "contact@example.com",
      }),
    });

    const res = await request(app).get("/api/usage").set("x-api-key", validKey).expect(200);

    expect(res.body.label).toBe("CI key");
    expect(res.body.owner).toBe("Owner Name");
    expect(res.body.keyPrefix).toBe("amethyst_live_abc");
    expect(res.body.developerAccount).toEqual({
      id: "507f1f77bcf86cd799439011",
      displayName: "Acme Draft",
      organization: "Acme Org",
      contactEmail: "contact@example.com",
    });
  });

  it("returns developerAccount null when account doc is missing", async () => {
    findOneMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        owner: "Legacy",
        label: "L",
        email: null,
        developerAccountId: "507f1f77bcf86cd799439099",
        tier: "premium",
        scopes: ["valuation"],
        keyPrefix: "amethyst_live_z",
        usageCount: 0,
        lastUsed: null,
        createdAt: null,
        expiresAt: null,
        isActive: true,
      }),
    });
    findByIdMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const res = await request(app).get("/api/usage").set("x-api-key", validKey).expect(200);
    expect(res.body.developerAccount).toBeNull();
  });

  it("returns developerAccount null when key has no developerAccountId", async () => {
    findOneMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        owner: "Solo",
        label: "Solo key",
        email: null,
        developerAccountId: null,
        tier: "free",
        scopes: ["valuation"],
        keyPrefix: "amethyst_live_solo",
        usageCount: 1,
        lastUsed: null,
        createdAt: null,
        expiresAt: null,
        isActive: true,
      }),
    });

    const res = await request(app).get("/api/usage").set("x-api-key", validKey).expect(200);
    expect(res.body.developerAccount).toBeNull();
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
