import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import developersRoutes from "../src/routes/developers";
import errorHandler from "../src/middleware/errorHandler";

const findMock = vi.fn();
const findOneMock = vi.fn();
const createMock = vi.fn();

vi.mock("../src/models/DeveloperAccount", () => ({
  default: {
    find: (...args: unknown[]) => findMock(...args),
    findOne: (...args: unknown[]) => findOneMock(...args),
    create: (...args: unknown[]) => createMock(...args),
  },
}));

describe("/api/developers routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/developers", developersRoutes);
  app.use(errorHandler);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("lists active developer accounts", async () => {
    findMock.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            _id: "507f1f77bcf86cd799439012",
            displayName: "Draft Lab",
            contactEmail: "lab@example.com",
            organization: "Draft Co",
            isActive: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
      }),
    });

    const res = await request(app).get("/api/developers").expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].displayName).toBe("Draft Lab");
  });

  it("creates a developer account", async () => {
    findOneMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    createMock.mockResolvedValue({
      _id: "507f1f77bcf86cd799439013",
      displayName: "Acme Draft",
      contactEmail: "a@b.co",
      organization: "Acme",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/api/developers")
      .send({ displayName: "Acme Draft", contactEmail: "a@b.co", organization: "Acme" })
      .expect(201);
    expect(res.body.id).toBe("507f1f77bcf86cd799439013");
    expect(res.body.displayName).toBe("Acme Draft");
  });
});
