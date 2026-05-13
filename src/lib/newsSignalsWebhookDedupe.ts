/**
 * In-process dedupe + throttle for outbound `signals_updated` webhook POSTs.
 *
 * Why this exists
 * ---------------
 * `fetchSignals()` previously gated webhook fan-out on a Redis-stored ETag
 * (`previousFingerprint !== fingerprint`). That breaks open when Redis is
 * unreachable (production App Runner has no `REDIS_URL` today, so
 * `getCached` returns `null` instantly and `null !== <hash>` is true on
 * every call). Without an in-process fallback, **every** licensed
 * `GET /signals/news` cache miss fanned out a POST to every subscribed
 * Draftroom URL, producing the observed ~12 hooks/minute.
 *
 * Design
 * ------
 * - Pure in-memory `Map<url, Entry>`. No Redis, no Mongo, no disk.
 * - Each entry stores the last semantic `fingerprint` (excludes
 *   `occurred_at` / `fetched_at`), the last successful `sentAtMs`, and the
 *   payload `count` for log enrichment.
 * - `shouldSendWebhook` returns `{ send, reason }`. Reasons:
 *     "first_send"          — no prior entry for this URL
 *     "fingerprint_changed" — semantic content changed since last send
 *     "skipped_unchanged"   — same fingerprint, do not POST
 *     "skipped_throttled"   — same fingerprint **and** within the
 *                             min-interval; do not POST
 * - LRU-bounded at 256 URLs (more than realistic subscriber count) to
 *   defend against pathological URL churn / hot-reloaded test imports.
 *
 * What this does NOT do
 * ---------------------
 * - Cross-instance dedupe. App Runner runs 1–2 instances; if both are
 *   hot, each maintains its own memo. That at worst doubles the floor
 *   rate (one POST per instance per genuine snapshot change), still
 *   bounded by the per-URL min-interval. The previous Redis-ETag layer
 *   *would* cover cross-instance dedupe when Redis is healthy, and is
 *   still applied as a fast-path filter in `fetchSignals`.
 * - Retry. Failures are logged and dropped — the next genuine snapshot
 *   change will retry organically. Tight retry loops are explicitly out
 *   of scope (axios already has a single attempt; we add nothing).
 *
 * Env knobs (optional, read at call time)
 *   AMETHYST_NEWS_WEBHOOK_MIN_INTERVAL_MS   default 5000, clamp 0..60000
 *   AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE    "1" to bypass (debug only;
 *                                            equivalent to always-fire)
 */

const DEFAULT_MIN_INTERVAL_MS = 5_000;
const MIN_INTERVAL_FLOOR_MS = 0;
const MIN_INTERVAL_CEIL_MS = 60_000;
const MAX_ENTRIES = 256;

type DedupeEntry = {
  fingerprint: string;
  sentAtMs: number;
  count: number;
};

const lastSentByUrl = new Map<string, DedupeEntry>();

function readMinIntervalMs(): number {
  const raw = process.env.AMETHYST_NEWS_WEBHOOK_MIN_INTERVAL_MS;
  if (raw == null || raw === "") return DEFAULT_MIN_INTERVAL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_MIN_INTERVAL_MS;
  if (n < MIN_INTERVAL_FLOOR_MS) return MIN_INTERVAL_FLOOR_MS;
  if (n > MIN_INTERVAL_CEIL_MS) return MIN_INTERVAL_CEIL_MS;
  return n;
}

function isDedupeDisabled(): boolean {
  return process.env.AMETHYST_DISABLE_NEWS_WEBHOOK_DEDUPE === "1";
}

/**
 * Maintain an upper bound on the memo by evicting the oldest entry once
 * the map exceeds `MAX_ENTRIES`. Map iteration order is insertion-order;
 * we refresh insertion order on every `recordWebhookSend` so the LRU
 * eviction picks the genuinely-oldest entry.
 */
function evictIfFull(): void {
  while (lastSentByUrl.size > MAX_ENTRIES) {
    const firstKey = lastSentByUrl.keys().next().value;
    if (firstKey === undefined) break;
    lastSentByUrl.delete(firstKey);
  }
}

export type WebhookDedupeDecision = {
  send: boolean;
  reason:
    | "first_send"
    | "fingerprint_changed"
    | "skipped_unchanged"
    | "skipped_throttled"
    | "dedupe_disabled";
  lastSentAtMs?: number;
  lastFingerprint?: string;
  minIntervalMs: number;
};

/**
 * Decide whether to POST `fingerprint` to `url` right now. Does not
 * mutate state — callers must call `recordWebhookSend` after a successful
 * (or attempted) POST so subsequent calls can compare against it.
 *
 * Throttle semantics:
 *   - Same fingerprint as last send → `skipped_unchanged` (no time check).
 *   - Different fingerprint AND (now - last) < minInterval → still send;
 *     the throttle protects against same-fingerprint flapping only.
 *   - This matches the prompt: "do not POST if fingerprint has not
 *     changed since last successful/attempted post for that webhook URL."
 */
export function shouldSendWebhook(
  url: string,
  fingerprint: string,
  opts: { now?: number; minIntervalMs?: number } = {}
): WebhookDedupeDecision {
  const minIntervalMs = opts.minIntervalMs ?? readMinIntervalMs();
  if (isDedupeDisabled()) {
    return { send: true, reason: "dedupe_disabled", minIntervalMs };
  }
  const now = opts.now ?? Date.now();
  const entry = lastSentByUrl.get(url);
  if (entry == null) {
    return { send: true, reason: "first_send", minIntervalMs };
  }
  if (entry.fingerprint !== fingerprint) {
    return {
      send: true,
      reason: "fingerprint_changed",
      lastSentAtMs: entry.sentAtMs,
      lastFingerprint: entry.fingerprint,
      minIntervalMs,
    };
  }
  // Same fingerprint → never POST. If we're inside the min-interval
  // window we additionally surface "throttled" so logs distinguish a
  // fast-replay from a steady-state idle.
  const sinceMs = now - entry.sentAtMs;
  return {
    send: false,
    reason: sinceMs < minIntervalMs ? "skipped_throttled" : "skipped_unchanged",
    lastSentAtMs: entry.sentAtMs,
    lastFingerprint: entry.fingerprint,
    minIntervalMs,
  };
}

/**
 * Record a POST attempt so the next `shouldSendWebhook` call has memory.
 * Refreshes insertion order to keep LRU eviction correct.
 */
export function recordWebhookSend(
  url: string,
  fingerprint: string,
  count: number,
  now: number = Date.now()
): void {
  if (typeof url !== "string" || url.length === 0) return;
  lastSentByUrl.delete(url);
  lastSentByUrl.set(url, { fingerprint, sentAtMs: now, count });
  evictIfFull();
}

/** Test helper — never call from runtime code. */
export function clearWebhookDedupe(): void {
  lastSentByUrl.clear();
}

/** Test/inspection helper — never call from runtime code. */
export function __webhookDedupeSize(): number {
  return lastSentByUrl.size;
}

/** Test/inspection helper — never call from runtime code. */
export function __peekWebhookDedupeEntry(url: string): DedupeEntry | undefined {
  return lastSentByUrl.get(url);
}
