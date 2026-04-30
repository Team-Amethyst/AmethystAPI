import type { LeanPlayer } from "../types/brain";

const DEFAULT_NUMERIC = {
  value: 0,
  adp: 9999,
  tier: 0,
} as const;

function coerceFiniteNumber(
  raw: unknown,
  fallback: number
): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function coerceTier(raw: unknown): number {
  const n = coerceFiniteNumber(raw, DEFAULT_NUMERIC.tier);
  return Math.max(0, Math.trunc(n));
}

function coerceMlbId(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t && /^\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isSafeInteger(n)) return n;
    }
  }
  return undefined;
}

function coercePositions(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const arr = raw.filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0
    );
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const arr = raw
      .split(/[,/|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}

/**
 * Coerce Mongo `players` documents into safe numeric fields for valuation math.
 * Logs one line per coerced row so operators can fix upstream sync issues.
 */
export function normalizeCatalogPlayers(
  docs: unknown[],
  onIssue: (message: string) => void
): LeanPlayer[] {
  const rows: LeanPlayer[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (doc == null || typeof doc !== "object") {
      onIssue(`players[${i}]: skipped, not an object`);
      continue;
    }

    const d = doc as Record<string, unknown>;
    const label = String(d.mlbId ?? d._id ?? i);

    const rawValue = d.value;
    const value = coerceFiniteNumber(rawValue, DEFAULT_NUMERIC.value);
    if (value !== rawValue) {
      onIssue(`player ${label}: invalid value, using 0`);
    }

    const rawAdp = d.adp;
    const adp = coerceFiniteNumber(rawAdp, DEFAULT_NUMERIC.adp);
    if (adp !== rawAdp) {
      onIssue(`player ${label}: invalid adp, using 9999`);
    }

    const rawTier = d.tier;
    const tier = coerceTier(rawTier);
    if (tier !== rawTier) {
      onIssue(`player ${label}: invalid tier, using 0`);
    }

    const mlbId = coerceMlbId(d.mlbId);
    const positions = coercePositions(d.positions);

    rows.push({
      _id: d._id,
      mlbId,
      name: typeof d.name === "string" ? d.name : "Unknown",
      team: typeof d.team === "string" ? d.team : "",
      position: typeof d.position === "string" ? d.position : "",
      ...(positions ? { positions } : {}),
      adp,
      tier,
      value,
      outlook: typeof d.outlook === "string" ? d.outlook : undefined,
      stats:
        d.stats != null && typeof d.stats === "object"
          ? (d.stats as Record<string, unknown>)
          : undefined,
      projection:
        d.projection != null && typeof d.projection === "object"
          ? (d.projection as Record<string, unknown>)
          : undefined,
    });
  }

  return rows;
}
