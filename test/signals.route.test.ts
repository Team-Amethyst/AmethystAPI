import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/redis", () => ({
  getCached: vi.fn(),
}));

vi.mock("../src/services/newsService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/newsService")>();
  return {
    ...actual,
    fetchSignals: vi.fn(),
  };
});

import {
  formatEtagHeader,
  stableSignalsPayloadFingerprint,
} from "../src/lib/signalsHttp";
import signalsRoutes from "../src/routes/signals";
import { getCached } from "../src/lib/redis";
import { fetchSignals } from "../src/services/newsService";

const mockedGetCached = vi.mocked(getCached);
const mockedFetchSignals = vi.mocked(fetchSignals);

describe("/signals/news", () => {
  const app = express();
  app.use("/signals", signalsRoutes);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 304 and skips fetchSignals when If-None-Match matches cached etag", async () => {
    mockedGetCached.mockImplementation(async (key: string) => {
      if (key.endsWith(":http-etag")) return "beef42";
      return null;
    });

    const res = await request(app)
      .get("/signals/news")
      .set("If-None-Match", '"beef42"')
      .expect(304);

    expect(res.text).toBe("");
    expect(mockedFetchSignals).not.toHaveBeenCalled();
  });

  it("returns JSON and ETag on 200", async () => {
    mockedGetCached.mockResolvedValue(null);
    mockedFetchSignals.mockResolvedValue({
      signals: [],
      fetched_at: "2026-01-01T00:00:00.000Z",
      count: 0,
    });

    const res = await request(app).get("/signals/news").expect(200);

    expect(res.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.body.count).toBe(0);
    expect(mockedFetchSignals).toHaveBeenCalledTimes(1);
  });

  it("returns 304 after fetch when payload matches If-None-Match (no redis etag)", async () => {
    mockedGetCached.mockResolvedValue(null);
    mockedFetchSignals.mockResolvedValue({
      signals: [],
      fetched_at: "2026-01-01T00:00:00.000Z",
      count: 0,
    });

    const fp = stableSignalsPayloadFingerprint([], 0);

    const res = await request(app)
      .get("/signals/news")
      .set("If-None-Match", formatEtagHeader(fp))
      .expect(304);

    expect(res.text).toBe("");
    expect(mockedFetchSignals).toHaveBeenCalledTimes(1);
  });
});
