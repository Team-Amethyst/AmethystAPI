import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("notifyNewsSignalsWebhookSubscribers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findChain.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            keyPrefix: "amethyst_live_a",
            newsSignalsWebhookUrl:
              "https://draft.example.com/api/internal/news-signals/hook",
            key: null,
            newsSignalsWebhookBearerSealed: "sealed-custom",
          },
        ]),
      }),
    });
  });

  it("POSTs once per subscribed API key", async () => {
    const { notifyNewsSignalsWebhookSubscribers } = await import(
      "../src/services/draftNewsSignalsWebhook"
    );

    await notifyNewsSignalsWebhookSubscribers();

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      "https://draft.example.com/api/internal/news-signals/hook",
      expect.objectContaining({ event: "signals_updated" }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer webhook-bearer-token",
        }),
      })
    );
  });
});
