import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import portalAuthRoutes from "../src/routes/portalAuth";
import errorHandler from "../src/middleware/errorHandler";
import { hashPortalPassword } from "../src/lib/portalAuth";

const findOneUserMock = vi.fn();
const createUserMock = vi.fn();
const findByIdUserMock = vi.fn();
const findByIdDevMock = vi.fn();
const findOneDevMock = vi.fn();
const createDevMock = vi.fn();

vi.mock("../src/models/PortalUser", () => ({
  default: {
    findOne: (...args: unknown[]) => findOneUserMock(...args),
    create: (...args: unknown[]) => createUserMock(...args),
    findById: (...args: unknown[]) => findByIdUserMock(...args),
  },
}));

vi.mock("../src/models/DeveloperAccount", () => ({
  default: {
    findById: (...args: unknown[]) => findByIdDevMock(...args),
    findOne: (...args: unknown[]) => findOneDevMock(...args),
    create: (...args: unknown[]) => createDevMock(...args),
  },
}));

describe("/api/auth routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", portalAuthRoutes);
  app.use(errorHandler);

  beforeEach(() => {
    vi.resetAllMocks();
    findOneUserMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    findOneDevMock.mockResolvedValue(null);
    createDevMock.mockResolvedValue({
      _id: "507f1f77bcf86cd799439011",
      displayName: "Draft Lab",
      contactEmail: "lab@example.com",
      organization: null,
      isActive: true,
    });
  });

  it("registers and sets session cookie", async () => {
    createUserMock.mockResolvedValue({
      _id: "507f1f77bcf86cd799439021",
      email: "lab@example.com",
      displayName: "Draft Lab",
    });

    const res = await request(app)
      .post("/api/auth/register")
      .send({
        displayName: "Draft Lab",
        email: "lab@example.com",
        password: "strongpass123",
      })
      .expect(201);

    expect(res.body.user.email).toBe("lab@example.com");
    expect(String(res.headers["set-cookie"] || "")).toContain("amethyst_portal_session=");
  });

  it("rejects duplicate register email", async () => {
    findOneUserMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: "u1" }),
    });
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        displayName: "Draft Lab",
        email: "lab@example.com",
        password: "strongpass123",
      })
      .expect(409);
    expect(res.body.error?.code).toBe("PORTAL_EMAIL_TAKEN");
  });

  it("logs in and returns account context", async () => {
    const p = hashPortalPassword("strongpass123");
    findOneUserMock.mockResolvedValue({
      _id: "507f1f77bcf86cd799439021",
      email: "lab@example.com",
      displayName: "Draft Lab",
      developerAccountId: "507f1f77bcf86cd799439011",
      isActive: true,
      passwordSalt: p.passwordSalt,
      passwordHash: p.passwordHash,
      save: vi.fn().mockResolvedValue(undefined),
    });
    findByIdDevMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        displayName: "Draft Lab",
        contactEmail: "lab@example.com",
        organization: "Acme",
        isActive: true,
      }),
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "lab@example.com", password: "strongpass123" })
      .expect(200);
    expect(res.body.user.email).toBe("lab@example.com");
  });
});
