import axios from "axios";
import { env } from "../config/env";
import { logger } from "../lib/logger";

/**
 * After fresh MLB-backed signals are cached, notify Draft API so the BFF can
 * refetch GET /signals/news (with If-None-Match) and broadcast to browsers.
 */
/** Bearer Draft validates: INTERNAL_WEBHOOK_SECRET if set on Draft, else AMETHYST_API_KEY. */
export function resolveDraftNewsSignalsWebhookBearer(): string | undefined {
  return env.internalWebhookSecret || env.amethystApiKey;
}

export async function notifyDraftNewsSignalsWebhook(): Promise<void> {
  const url = env.draftNewsSignalsWebhookUrl;
  const bearer = resolveDraftNewsSignalsWebhookBearer();
  if (!url) return;
  if (!bearer) {
    logger.warn(
      { component: "DraftNewsSignalsWebhook" },
      "DRAFT_NEWS_SIGNALS_WEBHOOK_URL is set but neither INTERNAL_WEBHOOK_SECRET nor AMETHYST_API_KEY is set; skipping notify"
    );
    return;
  }

  const occurredAt = new Date().toISOString();
  try {
    await axios.post(
      url,
      { event: "signals_updated", occurred_at: occurredAt },
      {
        timeout: 8000,
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        component: "DraftNewsSignalsWebhook",
      },
      "Draft news-signals webhook failed"
    );
  }
}
