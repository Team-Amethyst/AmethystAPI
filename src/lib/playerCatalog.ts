import type { LeanPlayer } from "../types/brain";
import type { CatalogKind } from "./catalogRowClassification";

const DEFAULT_NUMERIC = {
  value: 0,
  catalog_rank: 9999,
  catalog_tier: 0,
} as const;

function coerceFiniteNumber(
  raw: unknown,
  fallback: number
): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function coerceTier(raw: unknown): number {
  const n = coerceFiniteNumber(raw, DEFAULT_NUMERIC.catalog_tier);
  return Math.max(0, Math.trunc(n));
}

function coercePositiveInt(raw: unknown): number | undefined {
  const n = coerceFiniteNumber(raw, Number.NaN);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);
}

/** 0–3 injury severity for baseline; omit when absent or zero. */
function coerceInjurySeverity(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = coerceFiniteNumber(raw, Number.NaN);
  if (!Number.isFinite(n)) return undefined;
  const s = Math.min(3, Math.max(0, Math.trunc(n)));
  return s > 0 ? s : undefined;
}

function coerceCatalogKind(raw: unknown): CatalogKind | undefined {
  if (raw === "mlb" || raw === "custom") return raw;
  return undefined;
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

function pickMarketAdpFields(
  d: Record<string, unknown>
): Partial<
  Pick<
    LeanPlayer,
    | "market_adp"
    | "market_adp_source"
    | "market_adp_updated_at"
    | "market_adp_min"
    | "market_adp_max"
    | "market_pick_count"
  >
> {
  const out: Partial<
    Pick<
      LeanPlayer,
      | "market_adp"
      | "market_adp_source"
      | "market_adp_updated_at"
      | "market_adp_min"
      | "market_adp_max"
      | "market_pick_count"
    >
  > = {};
  const rawAdp = d.market_adp ?? d.marketAdp;
  if (typeof rawAdp === "number" && Number.isFinite(rawAdp) && rawAdp > 0) {
    out.market_adp = rawAdp;
  }
  const src = d.market_adp_source ?? d.marketAdpSource;
  if (typeof src === "string" && src.trim() !== "") {
    out.market_adp_source = src.trim();
  }
  const upd = d.market_adp_updated_at ?? d.marketAdpUpdatedAt;
  if (typeof upd === "string" && upd.trim() !== "") {
    out.market_adp_updated_at = upd.trim();
  }
  const mn = d.market_adp_min ?? d.marketAdpMin;
  if (typeof mn === "number" && Number.isFinite(mn)) {
    out.market_adp_min = mn;
  }
  const mx = d.market_adp_max ?? d.marketAdpMax;
  if (typeof mx === "number" && Number.isFinite(mx)) {
    out.market_adp_max = mx;
  }
  const pc = d.market_pick_count ?? d.marketPickCount;
  if (typeof pc === "number" && Number.isFinite(pc) && pc >= 0) {
    out.market_pick_count = Math.trunc(pc);
  }
  return out;
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

    const rawCatalogRank = d.catalog_rank ?? d.adp;
    const catalog_rank = coerceFiniteNumber(rawCatalogRank, DEFAULT_NUMERIC.catalog_rank);
    if (catalog_rank !== rawCatalogRank) {
      onIssue(`player ${label}: invalid catalog_rank, using 9999`);
    }

    const rawCatalogTier = d.catalog_tier ?? d.tier;
    const catalog_tier = coerceTier(rawCatalogTier);
    if (catalog_tier !== rawCatalogTier) {
      onIssue(`player ${label}: invalid catalog_tier, using 0`);
    }

    const mlbId = coerceMlbId(d.mlbId);
    const catalogKind = coerceCatalogKind(d.catalogKind);
    const positions = coercePositions(d.positions);
    const age = coercePositiveInt(d.age);
    const depthChartPosition = coercePositiveInt(
      d.depthChartPosition ?? d.depth_chart_position
    );
    const injurySeverity = coerceInjurySeverity(
      d.injurySeverity ?? d.injury_severity
    );

    rows.push({
      _id: d._id,
      mlbId,
      ...(catalogKind ? { catalogKind } : {}),
      name: typeof d.name === "string" ? d.name : "Unknown",
      team: typeof d.team === "string" ? d.team : "",
      position: typeof d.position === "string" ? d.position : "",
      ...(positions ? { positions } : {}),
      ...(age != null ? { age } : {}),
      ...(depthChartPosition != null ? { depthChartPosition } : {}),
      ...(injurySeverity != null ? { injurySeverity } : {}),
      catalog_rank,
      catalog_tier,
      ...pickMarketAdpFields(d),
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
