import axios from "axios";
import ApiKey from "../models/ApiKey";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { openPortalApiKeySecret, sealPortalApiKeySecret } from "../lib/portalApiKeySecret";
import {
  recordWebhookSend,
  shouldSendWebhook,
  type WebhookDedupeDecision,
} from "../lib/newsSignalsWebhookDedupe";

const WEBHOOK_TIMEOUT_MS = 8000;

/**
 * Snapshot a webhook batch operates on. `fingerprint` is the stable
 * semantic hash from `stableSignalsPayloadFingerprint` (excludes
 * `fetched_at` / volatile fields). `count` is informational so Draftroom
 * can size its downstream poll without re-fetching.
 */
export type NewsSignalsSnapshot = {
  fingerprint: string;
  count: number;
};

export function sealNewsSignalsWebhookBearer(plaintext: string): string {
  return sealPortalApiKeySecret(plaintext);
}

/** Resolve Bearer token for outbound POSTs to this key’s `newsSignalsWebhookUrl`. */
export function resolveBearerForStoredKey(doc: {
  key?: string | null;
  newsSignalsWebhookBearerSealed?: string | null;
}): string | null {
  const sealedBearer = doc.newsSignalsWebhookBearerSealed;
  if (typeof sealedBearer === "string" && sealedBearer.length > 0) {
    const t = openPortalApiKeySecret(sealedBearer);
    if (t) return t;
  }
  const sealedKey = doc.key;
  if (typeof sealedKey === "string" && sealedKey.length > 0) {
    return openPortalApiKeySecret(sealedKey);
  }
  return null;
}

/**
 * Optional global fallback (single URL) — legacy / ops. Prefer per–API-key URLs on ApiKey docs.
 */
export function resolveGlobalNewsSignalsWebhookBearer(): string | undefined {
  return env.internalWebhookSecret || env.amethystApiKey;
}

/** Truncate sha256 hex to 12 chars for log enrichment; never logs the full hash. */
function fingerprintPrefix(fp: string | undefined): string | null {
  if (typeof fp !== "string" || fp.length === 0) return null;
  return fp.slice(0, 12);
}

/**
 * Parse `url` into `{host, path}` for logging without leaking query
 * strings or secrets. Returns nulls when the URL is malformed (we still
 * POST — the malformed URL surfaces as the axios error).
 */
function describeUrl(url: string): { host: string | null; path: string | null } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: null, path: null };
  }
}

async function postSignalsUpdated(
  url: string,
  bearer: string,
  snapshot: NewsSignalsSnapshot
): Promise<void> {
  const occurredAt = new Date().toISOString();
  const body = {
    event: "signals_updated" as const,
    source: "engine" as const,
    fingerprint: snapshot.fingerprint,
    count: snapshot.count,
    occurred_at: occurredAt,
  };
  await axios.post(url, body, {
    timeout: WEBHOOK_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    validateStatus: (s) => s >= 200 && s < 300,
  });
}

export type PortalWebhookPostResult = {
  status: number;
  ok: boolean;
};

/**
 * POST arbitrary JSON to a webhook URL (portal “send custom message” /
 * portal_test path). Bypasses the dedupe memo on purpose — portal-driven
 * pings are ephemeral and must always fire.
 *
 * Returns HTTP status without throwing on 4xx/5xx so the caller can surface it.
 */
export async function postCustomWebhookPayload(
  url: string,
  bearer: string,
  payload: unknown
): Promise<PortalWebhookPostResult> {
  const { host, path } = describeUrl(url);
  const res = await axios.post(url, payload, {
    timeout: WEBHOOK_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
  });
  const status = res.status;
  const ok = status >= 200 && status < 300;
  logger.info(
    {
      component: "DraftNewsSignalsWebhook",
      action: ok ? "sent" : "failed",
      event: "custom_payload",
      source: "portal_test",
      webhookHost: host,
      webhookPath: path,
      status,
      attempt: 1,
      dedupe: "bypassed",
    },
    "webhook_dispatch"
  );
  return { status, ok };
}

/**
 * Send one `signals_updated` POST to `url` if dedupe allows.
 * - First send for a URL OR fingerprint change → POST.
 * - Same fingerprint → skip (regardless of time since last).
 * - Records the send (success or failure) so subsequent identical
 *   fingerprints skip — failures retry organically only on the next
 *   genuine snapshot change. Tight retry loops are out of scope.
 *
 * Returns the dedupe decision so callers / tests can assert behavior.
 */
async function dispatchSignalsUpdated(
  url: string,
  bearer: string,
  snapshot: NewsSignalsSnapshot,
  keyPrefix: string | undefined
): Promise<WebhookDedupeDecision> {
  const { host, path } = describeUrl(url);
  const decision = shouldSendWebhook(url, snapshot.fingerprint);

  if (!decision.send) {
    logger.info(
      {
        component: "DraftNewsSignalsWebhook",
        action: decision.reason, // skipped_unchanged | skipped_throttled
        event: "signals_updated",
        source: "engine",
        webhookHost: host,
        webhookPath: path,
        fingerprintPrefix: fingerprintPrefix(snapshot.fingerprint),
        lastFingerprintPrefix: fingerprintPrefix(decision.lastFingerprint),
        count: snapshot.count,
        minIntervalMs: decision.minIntervalMs,
        keyPrefix,
      },
      "webhook_dispatch"
    );
    return decision;
  }

  try {
    await postSignalsUpdated(url, bearer, snapshot);
    recordWebhookSend(url, snapshot.fingerprint, snapshot.count);
    logger.info(
      {
        component: "DraftNewsSignalsWebhook",
        action: "sent",
        event: "signals_updated",
        source: "engine",
        webhookHost: host,
        webhookPath: path,
        fingerprintPrefix: fingerprintPrefix(snapshot.fingerprint),
        count: snapshot.count,
        status: 200,
        attempt: 1,
        reason: decision.reason,
        keyPrefix,
      },
      "webhook_dispatch"
    );
  } catch (err) {
    // Record the attempt so a follow-up call with the same fingerprint
    // still dedupes (avoids a tight retry loop that hammers a 5xx
    // endpoint). The next genuine snapshot change will retry.
    recordWebhookSend(url, snapshot.fingerprint, snapshot.count);
    logger.warn(
      {
        component: "DraftNewsSignalsWebhook",
        action: "failed",
        event: "signals_updated",
        source: "engine",
        webhookHost: host,
        webhookPath: path,
        fingerprintPrefix: fingerprintPrefix(snapshot.fingerprint),
        count: snapshot.count,
        attempt: 1,
        err: (err as Error).message,
        keyPrefix,
      },
      "webhook_dispatch"
    );
  }
  return decision;
}

async function notifyGlobalEnvNewsSignalsWebhook(
  snapshot: NewsSignalsSnapshot
): Promise<void> {
  const url = env.draftNewsSignalsWebhookUrl;
  const bearer = resolveGlobalNewsSignalsWebhookBearer();
  if (!url) return;
  if (!bearer) {
    logger.warn(
      { component: "DraftNewsSignalsWebhook" },
      "DRAFT_NEWS_SIGNALS_WEBHOOK_URL is set but neither INTERNAL_WEBHOOK_SECRET nor AMETHYST_API_KEY is set; skipping global notify"
    );
    return;
  }
  await dispatchSignalsUpdated(url, bearer, snapshot, "global-env");
}

async function notifyPerApiKeyNewsSignalsWebhooks(
  snapshot: NewsSignalsSnapshot
): Promise<void> {
  let keys;
  try {
    keys = await ApiKey.find({
      isActive: true,
      scopes: "signals",
    })
      .select("+key +newsSignalsWebhookBearerSealed newsSignalsWebhookUrl")
      .lean();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "DraftNewsSignalsWebhook" },
      "Could not load API keys for news-signals webhooks"
    );
    return;
  }

  for (const doc of keys) {
    const url = typeof doc.newsSignalsWebhookUrl === "string"
      ? doc.newsSignalsWebhookUrl.trim()
      : "";
    if (!url) continue;

    const bearer = resolveBearerForStoredKey(doc);
    if (!bearer) {
      logger.warn(
        {
          keyPrefix: doc.keyPrefix,
          component: "DraftNewsSignalsWebhook",
        },
        "Skipping news-signals webhook: no Bearer (set newsSignalsWebhookBearer or use a key with stored secret)"
      );
      continue;
    }

    await dispatchSignalsUpdated(url, bearer, snapshot, doc.keyPrefix);
  }
}

/**
 * After fresh MLB-backed signals are cached, notify subscribers: optional global env URL,
 * plus every API key with `newsSignalsWebhookUrl` and `signals` scope.
 *
 * The `snapshot` is the stable semantic fingerprint + row count. Two
 * sequential calls with the same `snapshot.fingerprint` POST at most
 * once per webhook URL — dedupe is in-process and survives Redis
 * outages.
 */
export async function notifyNewsSignalsWebhookSubscribers(
  snapshot: NewsSignalsSnapshot
): Promise<void> {
  await Promise.all([
    notifyGlobalEnvNewsSignalsWebhook(snapshot),
    notifyPerApiKeyNewsSignalsWebhooks(snapshot),
  ]);
}

/** @deprecated Alias retained for one release; new callers must pass a snapshot. */
export async function notifyDraftNewsSignalsWebhook(
  snapshot: NewsSignalsSnapshot
): Promise<void> {
  return notifyNewsSignalsWebhookSubscribers(snapshot);
}

/** @deprecated Use resolveGlobalNewsSignalsWebhookBearer */
export function resolveDraftNewsSignalsWebhookBearer(): string | undefined {
  return resolveGlobalNewsSignalsWebhookBearer();
}
