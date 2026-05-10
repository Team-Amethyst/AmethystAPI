/**
 * Pure helpers for catalog identity / duplicate detection (Mongo player docs).
 * Used by audit + repair scripts and unit tests — no DB access.
 */

export type CatalogIdentityRow = {
  _id: string;
  mlbId?: number | null;
  name: string;
  team: string;
  position: string;
  positions?: string[];
  adp: number;
  tier: number;
  value: number;
  projection?: unknown;
};

const OBJECT_ID_HEX = /^[a-f0-9]{24}$/i;

/** Lowercase, collapse spaces, strip accents, drop periods for Jr./Sr. noise. */
export function normalizePlayerName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Uppercase team; placeholder teams normalize to `--`. */
export function normalizeTeamAbbrev(team: string): string {
  const t = team.trim().toUpperCase();
  if (t === "" || t === "--" || t === "FA" || t === "N/A" || t === "UNK") return "--";
  return t;
}

export function normalizePrimaryPosition(position: string): string {
  return position.trim().toUpperCase();
}

/** Same rule as `getPlayerId` on lean players: prefer MLB id, else Mongo _id string. */
export function valuationPlayerIdFromRow(row: Pick<CatalogIdentityRow, "_id" | "mlbId">): string {
  if (row.mlbId != null && Number.isFinite(Number(row.mlbId))) {
    return String(Number(row.mlbId));
  }
  return String(row._id);
}

/** True when the Engine would use a 24-hex Mongo _id as `player_id` (no usable mlbId). */
export function isObjectIdStylePlayerId(playerId: string): boolean {
  return OBJECT_ID_HEX.test(playerId);
}

export function rowUsesObjectIdPlayerId(row: CatalogIdentityRow): boolean {
  return isObjectIdStylePlayerId(valuationPlayerIdFromRow(row));
}

export function hasCanonicalMlbId(row: CatalogIdentityRow): boolean {
  return row.mlbId != null && Number.isFinite(Number(row.mlbId)) && Number(row.mlbId) > 0;
}

export function projectionSummary(projection: unknown, maxLen = 400): string {
  if (projection == null) return "";
  try {
    const s = JSON.stringify(projection);
    return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
  } catch {
    return String(projection);
  }
}

/** Shallow batting HR/RBI/R and pitching SV for conflict checks. */
export function projectionFingerprint(projection: unknown): {
  hr?: number;
  rbi?: number;
  runs?: number;
  sb?: number;
  saves?: number;
} {
  if (projection == null || typeof projection !== "object") return {};
  const p = projection as Record<string, unknown>;
  const bat = (p.batting ?? {}) as Record<string, unknown>;
  const pit = (p.pitching ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };
  return {
    hr: num(bat.hr),
    rbi: num(bat.rbi),
    runs: num(bat.runs),
    sb: num(bat.sb),
    saves: num(pit.saves),
  };
}

export function fingerprintConflict(
  a: ReturnType<typeof projectionFingerprint>,
  b: ReturnType<typeof projectionFingerprint>
): boolean {
  const keys = ["hr", "rbi", "runs", "sb", "saves"] as const;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x == null || y == null) continue;
    if (Math.abs(x - y) > Math.max(3, 0.15 * Math.max(Math.abs(x), Math.abs(y)))) {
      return true;
    }
  }
  return false;
}

export type ShadowPair = {
  key: string;
  canonical: CatalogIdentityRow;
  shadow: CatalogIdentityRow;
};

function teamsMatchLoose(a: string, b: string): boolean {
  const ta = normalizeTeamAbbrev(a);
  const tb = normalizeTeamAbbrev(b);
  if (ta === tb) return true;
  if (ta === "--" || tb === "--") return true;
  return false;
}

/**
 * ObjectId-key row (no mlbId) that appears to duplicate a canonical MLB-id row.
 * Match: same normalized name + loose team (`--` matches any) + same primary position token.
 * Prefers canonical = same concrete team as shadow when possible, else higher `value`, lower ADP.
 */
export function findShadowPairs(rows: CatalogIdentityRow[]): ShadowPair[] {
  const withId = rows.filter(hasCanonicalMlbId);
  const byNamePos = new Map<string, CatalogIdentityRow[]>();
  for (const r of withId) {
    const k = `${normalizePlayerName(r.name)}\t${normalizePrimaryPosition(r.position)}`;
    if (!byNamePos.has(k)) byNamePos.set(k, []);
    byNamePos.get(k)!.push(r);
  }

  const pickCanonical = (shadow: CatalogIdentityRow, candidates: CatalogIdentityRow[]): CatalogIdentityRow => {
    const st = normalizeTeamAbbrev(shadow.team);
    const sameTeam = candidates.filter((c) => normalizeTeamAbbrev(c.team) === st && st !== "--");
    const pool = sameTeam.length > 0 ? sameTeam : candidates;
    return [...pool].sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      const adpA = Number.isFinite(a.adp) && a.adp > 0 ? a.adp : 9999;
      const adpB = Number.isFinite(b.adp) && b.adp > 0 ? b.adp : 9999;
      if (adpA !== adpB) return adpA - adpB;
      return a._id.localeCompare(b._id);
    })[0]!;
  };

  const out: ShadowPair[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (hasCanonicalMlbId(r)) continue;
    if (!rowUsesObjectIdPlayerId(r)) continue;
    const k = `${normalizePlayerName(r.name)}\t${normalizePrimaryPosition(r.position)}`;
    const cands = (byNamePos.get(k) ?? []).filter((c) => teamsMatchLoose(c.team, r.team));
    if (cands.length === 0) continue;
    const canonical = pickCanonical(r, cands);
    const dedup = `${canonical._id}|${r._id}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({ key: k, canonical, shadow: r });
  }
  return out;
}

/**
 * Given two rows (one should be canonical MLB-id, one ObjectId-only), pick canonical for merge policy.
 */
export function preferCanonicalMlbRow(
  a: CatalogIdentityRow,
  b: CatalogIdentityRow
): { canonical: CatalogIdentityRow; other: CatalogIdentityRow } {
  const aCanon = hasCanonicalMlbId(a);
  const bCanon = hasCanonicalMlbId(b);
  if (aCanon && !bCanon) return { canonical: a, other: b };
  if (!aCanon && bCanon) return { canonical: b, other: a };
  if (aCanon && bCanon) {
    return a.value >= b.value ? { canonical: a, other: b } : { canonical: b, other: a };
  }
  return a._id.localeCompare(b._id) <= 0 ? { canonical: a, other: b } : { canonical: b, other: a };
}

export function groupKeyName(rows: CatalogIdentityRow[]): Map<string, CatalogIdentityRow[]> {
  const m = new Map<string, CatalogIdentityRow[]>();
  for (const r of rows) {
    const k = normalizePlayerName(r.name);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

export function groupKeyNameTeam(rows: CatalogIdentityRow[]): Map<string, CatalogIdentityRow[]> {
  const m = new Map<string, CatalogIdentityRow[]>();
  for (const r of rows) {
    const k = `${normalizePlayerName(r.name)}\t${normalizeTeamAbbrev(r.team)}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

export function groupKeyNamePosition(rows: CatalogIdentityRow[]): Map<string, CatalogIdentityRow[]> {
  const m = new Map<string, CatalogIdentityRow[]>();
  for (const r of rows) {
    const k = `${normalizePlayerName(r.name)}\t${normalizePrimaryPosition(r.position)}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}
