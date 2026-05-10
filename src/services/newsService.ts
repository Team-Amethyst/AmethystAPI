import axios from "axios";
import { logger } from "../lib/logger";
import { classifyMlbTransaction } from "../lib/mlbTransactionSignals";
import { stableSignalsPayloadFingerprint } from "../lib/signalsHttp";
import { getCached, setCache } from "../lib/redis";
import type { NewsSignal, SignalSeverity, SignalsResponse } from "../types/brain";
import { notifyNewsSignalsWebhookSubscribers } from "./draftNewsSignalsWebhook";

const MLB_TRANSACTIONS_URL =
  "https://statsapi.mlb.com/api/v1/transactions";
const CACHE_TTL = 900; // 15 minutes
/** Keep validators longer than payload cache so conditional GET + webhook compare survive TTL expiry. */
const SIGNALS_ETAG_TTL = Math.max(CACHE_TTL * 10, 86_400);

const fmtDate = (d: Date) => d.toISOString().split("T")[0];

/** Redis key for MLB-derived signals (must stay aligned with `fetchSignals`). */
export function buildSignalsCacheKey(
  daysBack: number,
  signalTypeFilter?: string
): string {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - daysBack);
  return `ae:signals:${fmtDate(startDate)}:${fmtDate(now)}:${signalTypeFilter ?? "all"}`;
}

export function signalsHttpEtagCacheKey(dataCacheKey: string): string {
  return `${dataCacheKey}:http-etag`;
}

interface MlbTransaction {
  id: number;
  person?: { id: number; fullName: string };
  toTeam?: { abbreviation: string };
  fromTeam?: { abbreviation: string };
  typeCode?: string;
  typeDesc?: string;
  date?: string;
  effectiveDate?: string;
  description?: string;
  note?: string;
}

interface MlbTransactionsResponse {
  transactions?: MlbTransaction[];
}

/**
 * Fetches and normalises external baseball structural signals:
 * injury updates, role changes, trades, promotions, and demotions.
 *
 * Results are cached in Redis for 15 minutes to limit MLB API load.
 */
export async function fetchSignals(
  daysBack = 7,
  signalTypeFilter?: string
): Promise<SignalsResponse> {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - daysBack);

  const fmt = fmtDate;
  const cacheKey = buildSignalsCacheKey(daysBack, signalTypeFilter);

  const cached = await getCached<SignalsResponse>(cacheKey);
  if (cached) return cached;

  const etagKey = signalsHttpEtagCacheKey(cacheKey);
  const previousFingerprint = await getCached<string>(etagKey);

  const params: Record<string, string | number> = {
    sportId: 1,
    startDate: fmt(startDate),
    endDate: fmt(now),
  };

  let raw: MlbTransaction[] = [];
  try {
    const { data } = await axios.get<MlbTransactionsResponse>(
      MLB_TRANSACTIONS_URL,
      {
        params,
        timeout: 8000,
        // Only allow the known MLB Stats API host to prevent SSRF
        headers: { Accept: "application/json" },
      }
    );
    raw = data.transactions ?? [];
  } catch (err) {
    // External API failure is non-fatal; return empty signals rather than 500
    logger.warn(
      { err: (err as Error).message, component: "NewsService" },
      "MLB API unavailable"
    );
    raw = [];
  }

  const signals: NewsSignal[] = [];

  for (const tx of raw) {
    const typeCode = tx.typeCode ?? "";
    const typeDesc = tx.typeDesc ?? "";
    const classified = classifyMlbTransaction(
      typeCode,
      typeDesc,
      tx.description ?? tx.typeDesc
    );
    if (!classified) continue;

    // Apply optional filter
    if (signalTypeFilter && classified.type !== signalTypeFilter) continue;

    signals.push({
      player_name: tx.person?.fullName ?? "Unknown Player",
      signal_type: classified.type,
      severity: classified.severity,
      description: tx.description ?? tx.typeDesc ?? typeDesc,
      effective_date: tx.effectiveDate ?? tx.date ?? fmt(now),
      source: "MLB Transactions API",
    });
  }

  // Sort by severity desc (high → medium → low) then by date desc
  const severityOrder: Record<SignalSeverity, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  signals.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      b.effective_date.localeCompare(a.effective_date)
  );

  const response: SignalsResponse = {
    signals,
    fetched_at: new Date().toISOString(),
    count: signals.length,
  };

  const fingerprint = stableSignalsPayloadFingerprint(
    response.signals,
    response.count
  );

  await setCache(cacheKey, response, CACHE_TTL);
  await setCache(etagKey, fingerprint, SIGNALS_ETAG_TTL);

  if (previousFingerprint !== fingerprint) {
    void notifyNewsSignalsWebhookSubscribers();
  }

  return response;
}
