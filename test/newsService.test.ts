import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSignals } from "../src/services/newsService";
import fixture from "../test-fixtures/mlb-api/transactions.sample.json";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));
vi.mock("../src/lib/redis", () => ({
  getCached: vi.fn(),
  setCache: vi.fn(),
}));

import { getCached, setCache } from "../src/lib/redis";

const mockedGet = vi.mocked(axios.get);
const mockedGetCached = vi.mocked(getCached);
const mockedSetCache = vi.mocked(setCache);

describe("fetchSignals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetCached.mockResolvedValue(null);
    mockedSetCache.mockResolvedValue(undefined);
  });

  it("maps fixture transactions to injury, demotion, trade signals", async () => {
    mockedGet.mockResolvedValue({
      data: { transactions: fixture.transactions },
    });

    const res = await fetchSignals(7);

    expect(mockedGet).toHaveBeenCalledWith(
      "https://statsapi.mlb.com/api/v1/transactions",
      expect.objectContaining({
        params: expect.objectContaining({ sportId: 1 }),
        timeout: 8000,
      })
    );
    expect(res.count).toBe(4);
    const types = new Set(res.signals.map((s) => s.signal_type));
    expect(types.has("injury")).toBe(true);
    expect(types.has("demotion")).toBe(true);
    expect(types.has("trade")).toBe(true);
    expect(mockedSetCache).toHaveBeenCalledTimes(1);
  });

  it("returns cached response without calling MLB API", async () => {
    const cached = {
      signals: [],
      fetched_at: "2020-01-01T00:00:00.000Z",
      count: 0,
    };
    mockedGetCached.mockResolvedValue(cached);

    const res = await fetchSignals(7);
    expect(res).toBe(cached);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("returns empty signals when MLB API fails", async () => {
    mockedGet.mockRejectedValue(new Error("network"));

    const res = await fetchSignals(7);
    expect(res.signals).toEqual([]);
    expect(res.count).toBe(0);
  });
});
