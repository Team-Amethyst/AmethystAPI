import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import accountRoutes from "../src/routes/account";
import errorHandler from "../src/middleware/errorHandler";
import { issuePortalSessionToken } from "../src/lib/portalAuth";

const findByIdUserMock = vi.fn();
const findByIdDevMock = vi.fn();
const findKeysMock = vi.fn();
const createKeyMock = vi.fn();

vi.mock("../src/models/PortalUser", () => ({
  default: {
    findById: (...args: unknown[]) => findByIdUserMock(...args),
  },
}));

vi.mock("../src/models/DeveloperAccount", () => ({
  default: {
    findById: (...args: unknown[]) => findByIdDevMock(...args),
  },
}));

vi.mock("../src/models/ApiKey", () => ({
  default: {
    find: (...args: unknown[]) => findKeysMock(...args),
    create: (...args: unknown[]) => createKeyMock(...args),
  },
}));

describe("/api/account routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/account", accountRoutes);
  app.use(errorHandler);

  beforeEach(() => {
    vi.resetAllMocks();
    findByIdUserMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: "507f1f77bcf86cd799439021",
        email: "lab@example.com",
        displayName: "Draft Lab",
        developerAccountId: "507f1f77bcf86cd799439011",
        isActive: true,
      }),
    });
    findByIdDevMock.mockResolvedValue({
      _id: "507f1f77bcf86cd799439011",
      displayName: "Draft Lab",
      contactEmail: "lab@example.com",
      organization: "Acme",
      isActive: true,
    });
  });

  it("lists keys for signed-in account with bearer", async () => {
    findKeysMock.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            _id: "k1",
            label: "Production",
            owner: "Draft Lab",
            tier: "standard",
            scopes: ["valuation"],
            keyPrefix: "amethyst_live_abc",
            usageCount: 4,
            isActive: true,
          },
        ]),
      }),
    });
    const token = issuePortalSessionToken("507f1f77bcf86cd799439021");
    const res = await request(app)
      .get("/api/account/keys")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("rejects when session is missing", async () => {
    const res = await request(app).get("/api/account/keys").expect(401);
    expect(res.body.error?.code).toBe("PORTAL_SESSION_MISSING");
  });
});
