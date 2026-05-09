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
const deleteOneKeyMock = vi.fn();

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
    deleteOne: (...args: unknown[]) => deleteOneKeyMock(...args),
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
        select: vi.fn().mockReturnValue({
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
              key: null,
            },
          ]),
        }),
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

  it("deletes a key by id when it belongs to the signed-in account", async () => {
    deleteOneKeyMock.mockResolvedValue({ deletedCount: 1 });
    const token = issuePortalSessionToken("507f1f77bcf86cd799439021");
    const kid = "507f191e810c19729de860ea";
    const res = await request(app)
      .delete(`/api/account/keys/${kid}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    expect(res.text).toBe("");
    expect(deleteOneKeyMock).toHaveBeenCalledTimes(1);
    const arg = deleteOneKeyMock.mock.calls[0][0] as Record<string, unknown>;
    expect(String(arg._id)).toBe(kid);
    expect(String(arg.developerAccountId)).toBe("507f1f77bcf86cd799439011");
  });

  it("returns 404 when delete matches no document", async () => {
    deleteOneKeyMock.mockResolvedValue({ deletedCount: 0 });
    const token = issuePortalSessionToken("507f1f77bcf86cd799439021");
    const res = await request(app)
      .delete("/api/account/keys/507f191e810c19729de860ea")
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
    expect(res.body.error?.code).toBe("API_KEY_NOT_FOUND");
  });
});
