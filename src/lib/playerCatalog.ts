import type { LeanPlayer } from "../types/brain";

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
    const value =
      typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : 0;
    if (value !== rawValue) {
      onIssue(`player ${label}: invalid value, using 0`);
    }

    const rawAdp = d.adp;
    const adp =
      typeof rawAdp === "number" && Number.isFinite(rawAdp) ? rawAdp : 9999;
    if (adp !== rawAdp) {
      onIssue(`player ${label}: invalid adp, using 9999`);
    }

    const rawTier = d.tier;
    const tier =
      typeof rawTier === "number" && Number.isFinite(rawTier)
        ? Math.max(0, Math.trunc(rawTier))
        : 0;
    if (tier !== rawTier) {
      onIssue(`player ${label}: invalid tier, using 0`);
    }

    rows.push({
      _id: d._id,
      mlbId:
        typeof d.mlbId === "number" && Number.isFinite(d.mlbId)
          ? d.mlbId
          : undefined,
      name: typeof d.name === "string" ? d.name : "Unknown",
      team: typeof d.team === "string" ? d.team : "",
      position: typeof d.position === "string" ? d.position : "",
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
