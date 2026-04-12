import axios from "axios";
import { logger } from "../lib/logger";
import { getCached, setCache } from "../lib/redis";
import { NewsSignal, SignalsResponse, SignalSeverity, SignalType } from "../types/brain";

const MLB_TRANSACTIONS_URL =
  "https://statsapi.mlb.com/api/v1/transactions";
const CACHE_TTL = 900; // 15 minutes

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
 * Maps an MLB transaction type code + description to one of our signal types.
 */
function classifySignal(
  typeCode: string,
  typeDesc: string
): { type: SignalType; severity: SignalSeverity } | null {
  const code = typeCode.toUpperCase();
  const desc = typeDesc.toUpperCase();

  if (code === "IL" || desc.includes("INJURED LIST") || desc.includes("DISABLED LIST")) {
    let severity: SignalSeverity = "medium"; // default: 15-day IL
    if (desc.includes("60-DAY") || desc.includes("60 DAY")) severity = "high";
    else if (desc.includes("10-DAY") || desc.includes("10 DAY")) severity = "low";
    return { type: "injury", severity };
  }

  if (
    code === "RECALL" ||
    desc.includes("RECALLED") ||
    code === "ACTIVATE" ||
    desc.includes("ACTIVATED")
  ) {
    return { type: "promotion", severity: "low" };
  }

  if (
    code === "OPTION" ||
    desc.includes("OPTIONED") ||
    code === "DESIGNATE" ||
    desc.includes("DESIGNATED FOR ASSIGNMENT")
  ) {
    return { type: "demotion", severity: "medium" };
  }

  if (code === "TRADE" || desc.includes("TRADED")) {
    return { type: "trade", severity: "medium" };
  }

  // Role change: look for closer/setup/opener keywords
  if (
    desc.includes("CLOSER") ||
    desc.includes("SETUP MAN") ||
    desc.includes("OPENER") ||
    desc.includes("ROLE CHANGE")
  ) {
    return { type: "role_change", severity: "high" };
  }

  return null; // Unknown transaction type — skip
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

  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const cacheKey = `ae:signals:${fmt(startDate)}:${fmt(now)}:${signalTypeFilter ?? "all"}`;

  const cached = await getCached<SignalsResponse>(cacheKey);
  if (cached) return cached;

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
    const typeDesc = tx.typeDesc ?? tx.description ?? "";

    const classified = classifySignal(typeCode, typeDesc);
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

  await setCache(cacheKey, response, CACHE_TTL);
  return response;
}
