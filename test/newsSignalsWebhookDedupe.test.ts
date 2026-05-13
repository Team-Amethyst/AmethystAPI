import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __peekWebhookDedupeEntry,
  __webhookDedupeSize,
  clearWebhookDedupe,
  recordWebhookSend,
  shouldSendWebhook,
} from "../src/lib/newsSignalsWebhookDedupe";

const URL_A = "https://draft-a.example.com/api/internal/news-signals/hook";
const URL_B = "https://draft-b.example.com/api/internal/news-signals/hook";

describe("newsSignalsWebhookDedupe.shouldSendWebhook", () => {
  beforeEach(() => {
    clearWebhookDedupe();
    delete process.env.AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE;
    delete process.env.AMETHYST_NEWS_WEBHOOK_MIN_INTERVAL_MS;
  });

  afterEach(() => {
    clearWebhookDedupe();
    delete process.env.AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE;
    delete process.env.AMETHYST_NEWS_WEBHOOK_MIN_INTERVAL_MS;
  });

  it("first send for a URL → send=true reason=first_send", () => {
    const d = shouldSendWebhook(URL_A, "fp-1", { now: 1_000 });
    expect(d.send).toBe(true);
    expect(d.reason).toBe("first_send");
  });

  it("after recordWebhookSend, identical fingerprint → send=false reason=skipped_unchanged (outside min interval)", () => {
    recordWebhookSend(URL_A, "fp-1", 3, 0);
    const d = shouldSendWebhook(URL_A, "fp-1", { now: 60_000 }); // 60s later
    expect(d.send).toBe(false);
    expect(d.reason).toBe("skipped_unchanged");
    expect(d.lastFingerprint).toBe("fp-1");
  });

  it("identical fingerprint within min-interval → send=false reason=skipped_throttled", () => {
    recordWebhookSend(URL_A, "fp-1", 3, 0);
    const d = shouldSendWebhook(URL_A, "fp-1", { now: 1_000, minIntervalMs: 5_000 });
    expect(d.send).toBe(false);
    expect(d.reason).toBe("skipped_throttled");
  });

  it("changed fingerprint → send=true reason=fingerprint_changed (regardless of recency)", () => {
    recordWebhookSend(URL_A, "fp-1", 3, 0);
    const dRecent = shouldSendWebhook(URL_A, "fp-2", { now: 1_000 });
    expect(dRecent.send).toBe(true);
    expect(dRecent.reason).toBe("fingerprint_changed");
    expect(dRecent.lastFingerprint).toBe("fp-1");
  });

  it("two distinct URLs share no state", () => {
    recordWebhookSend(URL_A, "fp-1", 3, 0);
    const a = shouldSendWebhook(URL_A, "fp-1", { now: 60_000 });
    const b = shouldSendWebhook(URL_B, "fp-1", { now: 60_000 });
    expect(a.send).toBe(false);
    expect(b.send).toBe(true);
    expect(b.reason).toBe("first_send");
  });

  it("AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE=1 forces send=true reason=dedupe_disabled", () => {
    recordWebhookSend(URL_A, "fp-1", 3, 0);
    process.env.AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE = "1";
    const d = shouldSendWebhook(URL_A, "fp-1", { now: 60_000 });
    expect(d.send).toBe(true);
    expect(d.reason).toBe("dedupe_disabled");
  });

  it("AMETHYST_NEWS_WEBHOOK_MIN_INTERVAL_MS env is respected and clamped", () => {
    recordWebhookSend(URL_A, "fp-1", 3, 0);

    process.env.AMETHYST_NEWS_WEBHOOK_MIN_INTERVAL_MS = "10000";
    const a = shouldSendWebhook(URL_A, "fp-1", { now: 5_000 });
    expect(a.send).toBe(false);
    expect(a.reason).toBe("skipped_throttled");
    expect(a.minIntervalMs).toBe(10_000);

    // Negative is clamped to 0 → "skipped_unchanged" because window is now empty.
    process.env.AMETHYST_NEWS_WEBHOOK_MIN_INTERVAL_MS = "-50";
    const b = shouldSendWebhook(URL_A, "fp-1", { now: 1 });
    expect(b.minIntervalMs).toBe(0);
    expect(b.reason).toBe("skipped_unchanged");

    // Absurdly large is clamped down to 60_000.
    process.env.AMETHYST_NEWS_WEBHOOK_MIN_INTERVAL_MS = "999999";
    const c = shouldSendWebhook(URL_A, "fp-1", { now: 1 });
    expect(c.minIntervalMs).toBe(60_000);
  });

  it("LRU bound: entries beyond MAX_ENTRIES (256) evict oldest", () => {
    for (let i = 0; i < 260; i++) {
      recordWebhookSend(`https://example.com/hook/${i}`, "fp", 0, 1000 + i);
    }
    expect(__webhookDedupeSize()).toBe(256);
    // Oldest 4 must be gone.
    expect(__peekWebhookDedupeEntry("https://example.com/hook/0")).toBeUndefined();
    expect(__peekWebhookDedupeEntry("https://example.com/hook/3")).toBeUndefined();
    expect(__peekWebhookDedupeEntry("https://example.com/hook/4")).toBeDefined();
    // Newest still present.
    expect(__peekWebhookDedupeEntry("https://example.com/hook/259")).toBeDefined();
  });

  it("recordWebhookSend refreshes insertion order so re-recorded URLs are NOT evicted by newer ones", () => {
    for (let i = 0; i < 256; i++) {
      recordWebhookSend(`https://example.com/hook/${i}`, "fp", 0, 1000 + i);
    }
    // Re-record hook/0 so it becomes the youngest.
    recordWebhookSend("https://example.com/hook/0", "fp-fresh", 1, 9_999_999);
    // Now adding 4 more must NOT evict hook/0 — it must evict hook/1..4.
    for (let i = 256; i < 260; i++) {
      recordWebhookSend(`https://example.com/hook/${i}`, "fp", 0, 10_000_000 + i);
    }
    expect(__peekWebhookDedupeEntry("https://example.com/hook/0")?.fingerprint).toBe("fp-fresh");
    expect(__peekWebhookDedupeEntry("https://example.com/hook/1")).toBeUndefined();
    expect(__peekWebhookDedupeEntry("https://example.com/hook/4")).toBeUndefined();
    expect(__peekWebhookDedupeEntry("https://example.com/hook/5")).toBeDefined();
  });

  it("empty URL is ignored (defensive — no entry recorded)", () => {
    recordWebhookSend("", "fp", 0, 0);
    expect(__webhookDedupeSize()).toBe(0);
  });
});
