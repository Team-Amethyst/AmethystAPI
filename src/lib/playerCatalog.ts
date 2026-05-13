import type { CatalogValuationTier, LeanPlayer } from "../types/brain";
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

function coerceCatalogValuationTier(raw: unknown): CatalogValuationTier | undefined {
  if (raw === "valuation_eligible" || raw === "market_only" || raw === "roster_context") {
    return raw;
  }
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

/**
 * Coerce Mongo `_id` to a stable string at the catalog boundary.
 *
 * Why: downstream baseline math uses `String(p._id)` as a Map key
 * (see `scoringAwareBaselinePlayers`). When the catalog row is cached and
 * later returned via `structuredClone`, the BSON `ObjectId` instance is
 * stripped of its prototype and reduced to `{ buffer: { 0: ..., 11: ... } }`.
 * `String({...})` collapses to the literal string `"[object Object]"` for
 * every row, collapsing the Map (last write wins → uniform `$10` baselines
 * everywhere). Normalising `_id` to a hex string here means
 * `structuredClone` round-trips it as a primitive string and downstream
 * `String(p._id)` returns the canonical hex on both cold and cache-hit
 * paths.
 *
 * Accepts: ObjectId instances, plain objects with `toHexString`, plain
 * objects with `{buffer: Uint8Array | numeric-keyed object}`, strings,
 * or anything stringifiable.
 */
export function coerceCatalogIdToString(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "bigint") return String(raw);
  if (typeof raw === "object") {
    const obj = raw as {
      toHexString?: unknown;
      toString?: unknown;
      buffer?: unknown;
      id?: unknown;
    };
    if (typeof obj.toHexString === "function") {
      try {
        const h = (obj.toHexString as () => unknown).call(obj);
        if (typeof h === "string" && h.length > 0) return h;
      } catch {
        // fall through to other strategies
      }
    }
    if (obj.buffer && typeof obj.buffer === "object") {
      const buf = obj.buffer as Record<string, number> | ArrayLike<number>;
      const bytes: number[] = [];
      const len =
        typeof (buf as ArrayLike<number>).length === "number"
          ? (buf as ArrayLike<number>).length
          : 12;
      for (let i = 0; i < len; i++) {
        const b = Number((buf as Record<number, number>)[i]);
        if (!Number.isFinite(b)) return "";
        bytes.push(b & 0xff);
      }
      if (bytes.length > 0) {
        return bytes
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
    }
    if (typeof obj.toString === "function") {
      const s = obj.toString();
      if (typeof s === "string" && s !== "[object Object]") return s;
    }
  }
  return "";
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
    const catalogValuationTier = coerceCatalogValuationTier(
      d.catalogValuationTier ?? d.catalog_valuation_tier
    );

    rows.push({
      _id: coerceCatalogIdToString(d._id),
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
      ...(catalogValuationTier ? { catalogValuationTier } : {}),
    });
  }

  return rows;
}
