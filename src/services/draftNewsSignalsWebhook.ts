import axios from "axios";
import ApiKey from "../models/ApiKey";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { openPortalApiKeySecret, sealPortalApiKeySecret } from "../lib/portalApiKeySecret";

const WEBHOOK_TIMEOUT_MS = 8000;

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

async function postSignalsUpdated(url: string, bearer: string): Promise<void> {
  const occurredAt = new Date().toISOString();
  await axios.post(
    url,
    { event: "signals_updated", occurred_at: occurredAt },
    {
      timeout: WEBHOOK_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      validateStatus: (s) => s >= 200 && s < 300,
    }
  );
}

export type PortalWebhookPostResult = {
  status: number;
  ok: boolean;
};

/**
 * POST arbitrary JSON to a webhook URL (portal “send custom message”).
 * Returns HTTP status without throwing on 4xx/5xx so the caller can surface it.
 */
export async function postCustomWebhookPayload(
  url: string,
  bearer: string,
  payload: unknown
): Promise<PortalWebhookPostResult> {
  const res = await axios.post(url, payload, {
    timeout: WEBHOOK_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
  });
  const status = res.status;
  return { status, ok: status >= 200 && status < 300 };
}

async function notifyGlobalEnvNewsSignalsWebhook(): Promise<void> {
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
  try {
    await postSignalsUpdated(url, bearer);
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        component: "DraftNewsSignalsWebhook",
      },
      "Global Draft news-signals webhook failed"
    );
  }
}

async function notifyPerApiKeyNewsSignalsWebhooks(): Promise<void> {
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

    try {
      await postSignalsUpdated(url, bearer);
    } catch (err) {
      logger.warn(
        {
          err: (err as Error).message,
          keyPrefix: doc.keyPrefix,
          component: "DraftNewsSignalsWebhook",
        },
        "Per-key news-signals webhook failed"
      );
    }
  }
}

/**
 * After fresh MLB-backed signals are cached, notify subscribers: optional global env URL,
 * plus every API key with `newsSignalsWebhookUrl` and `signals` scope.
 */
export async function notifyNewsSignalsWebhookSubscribers(): Promise<void> {
  await Promise.all([
    notifyGlobalEnvNewsSignalsWebhook(),
    notifyPerApiKeyNewsSignalsWebhooks(),
  ]);
}

/** @deprecated Alias for `notifyNewsSignalsWebhookSubscribers`. */
export async function notifyDraftNewsSignalsWebhook(): Promise<void> {
  return notifyNewsSignalsWebhookSubscribers();
}

/** @deprecated Use resolveGlobalNewsSignalsWebhookBearer */
export function resolveDraftNewsSignalsWebhookBearer(): string | undefined {
  return resolveGlobalNewsSignalsWebhookBearer();
}
