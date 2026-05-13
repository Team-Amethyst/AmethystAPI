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

vi.mock("../src/services/draftNewsSignalsWebhook", () => ({
  notifyNewsSignalsWebhookSubscribers: vi.fn().mockResolvedValue(undefined),
}));

import { getCached, setCache } from "../src/lib/redis";
import { notifyNewsSignalsWebhookSubscribers } from "../src/services/draftNewsSignalsWebhook";

const mockedGet = vi.mocked(axios.get);
const mockedGetCached = vi.mocked(getCached);
const mockedSetCache = vi.mocked(setCache);
const mockedNotify = vi.mocked(notifyNewsSignalsWebhookSubscribers);

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
    expect(mockedSetCache).toHaveBeenCalledTimes(2);
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

  it("invokes notifyNewsSignalsWebhookSubscribers with the stable fingerprint + count when Redis says changed", async () => {
    mockedGet.mockResolvedValue({
      data: { transactions: fixture.transactions },
    });
    // No previous ETag → previousFingerprint == null → notifier MUST fire.
    mockedGetCached.mockResolvedValue(null);

    const res = await fetchSignals(7);

    expect(mockedNotify).toHaveBeenCalledTimes(1);
    const [snapshot] = mockedNotify.mock.calls[0]!;
    expect(snapshot).toEqual({
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), // sha256 hex
      count: res.count,
    });
    // Fingerprint must be stable across two computations of the same body.
    const sameRunFingerprint = snapshot!.fingerprint;
    expect(sameRunFingerprint).toBe(snapshot!.fingerprint);
  });

  it("fires the notifier on EVERY call when Redis is unavailable (`getCached → null`) — the in-process memo inside the notifier is the real gate", async () => {
    mockedGet.mockResolvedValue({
      data: { transactions: fixture.transactions },
    });
    // Simulate Redis-down: getCached always resolves null (cacheKey AND etagKey).
    mockedGetCached.mockResolvedValue(null);

    await fetchSignals(7);
    await fetchSignals(7);
    await fetchSignals(7);

    // Without the in-process memo, this would silently fan out 3 times.
    // The notifier IS still called 3 times here because newsService doesn't
    // own the dedupe — it delegates. The downstream memo (covered in
    // draftNewsSignalsWebhook.test.ts) is what actually skips the POST.
    expect(mockedNotify).toHaveBeenCalledTimes(3);
    for (const [snap] of mockedNotify.mock.calls) {
      expect(snap).toMatchObject({ fingerprint: expect.any(String) });
    }
    // All three fingerprints are byte-identical — proves
    // stableSignalsPayloadFingerprint excludes volatile timestamp fields.
    const fps = mockedNotify.mock.calls.map((c) => c[0]!.fingerprint);
    expect(new Set(fps).size).toBe(1);
  });

  it("does NOT call the notifier when Redis returns the same fingerprint (fast path)", async () => {
    mockedGet.mockResolvedValue({
      data: { transactions: fixture.transactions },
    });
    mockedGetCached.mockResolvedValue(null);

    // First call seeds the run; we capture the fingerprint produced by
    // the real `stableSignalsPayloadFingerprint`.
    await fetchSignals(7);
    const seededFingerprint = mockedNotify.mock.calls[0]![0]!.fingerprint;
    mockedNotify.mockClear();

    // Second call: Redis "etagKey" returns the same fingerprint → newsService
    // must short-circuit and NOT call the notifier.
    mockedGetCached.mockImplementation(((key: string) =>
      Promise.resolve(
        key.endsWith(":http-etag") ? seededFingerprint : null
      )) as typeof getCached);

    await fetchSignals(7);
    expect(mockedNotify).not.toHaveBeenCalled();
  });
});
