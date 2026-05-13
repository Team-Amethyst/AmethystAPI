import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebhookDedupe } from "../src/lib/newsSignalsWebhookDedupe";

vi.mock("../src/config/env", () => ({
  env: {
    draftNewsSignalsWebhookUrl: undefined,
    internalWebhookSecret: undefined,
    amethystApiKey: undefined,
  },
}));

vi.mock("../src/lib/portalApiKeySecret", () => ({
  openPortalApiKeySecret: vi.fn(() => "webhook-bearer-token"),
  sealPortalApiKeySecret: vi.fn((s: string) => `sealed:${s}`),
}));

vi.mock("axios", () => ({
  default: {
    post: vi.fn().mockResolvedValue({ status: 200 }),
  },
}));

const findChain = vi.fn();

vi.mock("../src/models/ApiKey", () => ({
  default: {
    find: (...args: unknown[]) => findChain(...args),
  },
}));

const HOOK_URL =
  "https://draft.example.com/api/internal/news-signals/hook";

function fixtureKey(overrides: Partial<{ keyPrefix: string; newsSignalsWebhookUrl: string }> = {}) {
  return {
    keyPrefix: overrides.keyPrefix ?? "amethyst_live_a",
    newsSignalsWebhookUrl: overrides.newsSignalsWebhookUrl ?? HOOK_URL,
    key: null,
    newsSignalsWebhookBearerSealed: "sealed-custom",
  };
}

function fixtureFind(keys: ReturnType<typeof fixtureKey>[]) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(keys),
    }),
  };
}

describe("notifyNewsSignalsWebhookSubscribers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWebhookDedupe();
    delete process.env.AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE;
    delete process.env.AMETHYST_NEWS_WEBHOOK_MIN_INTERVAL_MS;
    findChain.mockReturnValue(fixtureFind([fixtureKey()]));
  });

  it("POSTs once per subscribed API key with `event`, `source: engine`, `fingerprint`, `count`", async () => {
    const { notifyNewsSignalsWebhookSubscribers } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [postedUrl, postedBody, postedOptions] = vi.mocked(axios.post).mock.calls[0]!;
    expect(postedUrl).toBe(HOOK_URL);
    expect(postedBody).toMatchObject({
      event: "signals_updated",
      source: "engine",
      fingerprint: "fp-A",
      count: 3,
    });
    expect(postedBody).toHaveProperty("occurred_at");
    expect(postedOptions).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer webhook-bearer-token",
      }),
    });
  });

  it("dedupes: an identical fingerprint to the same URL is NOT re-POSTed", async () => {
    const { notifyNewsSignalsWebhookSubscribers } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });

    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it("a changed fingerprint to the same URL POSTs again", async () => {
    const { notifyNewsSignalsWebhookSubscribers } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-B", count: 4 });

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(axios.post).mock.calls[1]![1]).toMatchObject({
      fingerprint: "fp-B",
      count: 4,
    });
  });

  it("two different webhook URLs dedupe independently", async () => {
    const URL_A = HOOK_URL;
    const URL_B = "https://other.example.com/api/internal/news-signals/hook";
    findChain.mockReturnValue(
      fixtureFind([
        fixtureKey({ keyPrefix: "amethyst_live_a", newsSignalsWebhookUrl: URL_A }),
        fixtureKey({ keyPrefix: "amethyst_live_b", newsSignalsWebhookUrl: URL_B }),
      ])
    );

    const { notifyNewsSignalsWebhookSubscribers } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    // First call → 2 sends (one per URL, both first-send for that URL).
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 1 });
    expect(axios.post).toHaveBeenCalledTimes(2);
    // Second call same fingerprint → 0 new sends.
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 1 });
    expect(axios.post).toHaveBeenCalledTimes(2);
    // Third call new fingerprint → 2 new sends (one per URL, independent).
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-B", count: 2 });
    expect(axios.post).toHaveBeenCalledTimes(4);
  });

  it("two API keys sharing a webhook URL collapse to a single POST", async () => {
    findChain.mockReturnValue(
      fixtureFind([
        fixtureKey({ keyPrefix: "amethyst_live_a" }),
        fixtureKey({ keyPrefix: "amethyst_live_b" }),
      ])
    );

    const { notifyNewsSignalsWebhookSubscribers } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });
    // First key wins; second key sees the same URL already deduped.
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it("non-2xx response is logged but does NOT retry-loop, and dedupes subsequent identical fingerprints", async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error("502 Bad Gateway"));

    const { notifyNewsSignalsWebhookSubscribers } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });

    // Only the first attempt fired despite the failure — failures still
    // record the attempt so a tight retry loop is impossible.
    expect(axios.post).toHaveBeenCalledTimes(1);

    // A new fingerprint retries organically.
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-B", count: 4 });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it("AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE=1 bypasses dedupe", async () => {
    process.env.AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE = "1";

    const { notifyNewsSignalsWebhookSubscribers } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });
    await notifyNewsSignalsWebhookSubscribers({ fingerprint: "fp-A", count: 3 });

    expect(axios.post).toHaveBeenCalledTimes(2);

    delete process.env.AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE;
  });
});

describe("postCustomWebhookPayload (portal_test path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWebhookDedupe();
    vi.mocked(axios.post).mockResolvedValue({ status: 200 });
  });

  it("ALWAYS sends (does not consult dedupe memo) and returns status", async () => {
    const { postCustomWebhookPayload } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    const payload = { event: "portal_test", note: "ping" };
    const first = await postCustomWebhookPayload(HOOK_URL, "tok", payload);
    const second = await postCustomWebhookPayload(HOOK_URL, "tok", payload);

    expect(first).toEqual({ status: 200, ok: true });
    expect(second).toEqual({ status: 200, ok: true });
    // BOTH portal_test calls hit axios; the dedupe memo is bypassed.
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it("propagates 5xx status without throwing", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 502 });

    const { postCustomWebhookPayload } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    const result = await postCustomWebhookPayload(HOOK_URL, "tok", { ping: true });
    expect(result).toEqual({ status: 502, ok: false });
  });
});
