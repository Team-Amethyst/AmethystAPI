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
  catalog_rank: number;
  catalog_tier: number;
  value: number;
  projection?: unknown;
};

const OBJECT_ID_HEX = /^[a-f0-9]{24}$/i;

/** Lowercase, collapse spaces, strip accents, drop periods for Jr./Sr. noise. */
export function normalizePlayerName(name: string): string {
  let s = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "");
  // Drop trailing generational roman numerals (II / III / IV) after word boundaries.
  s = s.replace(/\b(ii|iii|iv)\b\s*$/i, "").trim();
  return s.replace(/\s+/g, " ").trim();
}

/** Uppercase team; placeholder teams normalize to `--`. */
export function normalizeTeamAbbrev(team: string): string {
  const t = team.trim().toUpperCase();
  if (t === "" || t === "--" || t === "FA" || t === "N/A" || t === "UNK") return "--";
  return t;
}

/**
 * Single canonical bucket per MLB franchise for **identity matching** (vendor ADP ↔ catalog).
 * Does not assert real-time roster validity; keeps KCR/KC, TBR/TB, etc. aligned.
 */
export function canonicalMlbTeamAbbrevForMatch(team: string): string {
  const t = normalizeTeamAbbrev(team);
  if (t === "--") return t;
  const bucket: Record<string, string> = {
    WAS: "WSH",
    WSN: "WSH",
    WSH: "WSH",
    AZ: "ARI",
    ARI: "ARI",
    ARZ: "ARI",
    CHW: "CHW",
    CWS: "CHW",
    KC: "KC",
    KCR: "KC",
    TB: "TB",
    TBR: "TB",
    SF: "SF",
    SFG: "SF",
    SD: "SD",
    SDP: "SD",
    ATH: "OAK",
    OAK: "OAK",
    MLW: "MIL",
    MIL: "MIL",
  };
  return bucket[t] ?? t;
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

const PITCHER_PRIMARY_TOKENS = new Set(["P", "SP", "RP"]);

/**
 * Primary position tokens match, or both are pitcher-family roles (P / SP / RP) so P↔RP is explainable.
 * Does not treat SS vs 2B as compatible — only pitcher bucket.
 */
export function positionsRolesCompatible(a: string, b: string): boolean {
  const pa = normalizePrimaryPosition(a);
  const pb = normalizePrimaryPosition(b);
  if (pa === pb) return true;
  return PITCHER_PRIMARY_TOKENS.has(pa) && PITCHER_PRIMARY_TOKENS.has(pb);
}

/**
 * Pitcher primary token differs (e.g. P vs RP) while still in the compatible family — needs manual review
 * before treating as a safe dedupe, even when projections align.
 */
export function isPitcherPrimaryTokenMismatch(canonicalPos: string, shadowPos: string): boolean {
  const a = normalizePrimaryPosition(canonicalPos);
  const b = normalizePrimaryPosition(shadowPos);
  if (a === b) return false;
  return PITCHER_PRIMARY_TOKENS.has(a) && PITCHER_PRIMARY_TOKENS.has(b);
}

/**
 * Canonical rows that could match an ObjectId-only shadow (same normalized name, loose team, compatible role).
 * Returns [] when ambiguous (multiple distinct mlbIds with no safe disambiguation).
 */
export function canonicalCandidatesForShadowOid(
  shadow: CatalogIdentityRow,
  withId: CatalogIdentityRow[]
): CatalogIdentityRow[] {
  const nk = normalizePlayerName(shadow.name);
  const cands = withId.filter(
    (c) =>
      normalizePlayerName(c.name) === nk &&
      teamsMatchLoose(c.team, shadow.team) &&
      positionsRolesCompatible(c.position, shadow.position)
  );
  if (cands.length === 0) return [];
  if (cands.length === 1) return cands;

  const st = normalizeTeamAbbrev(shadow.team);
  if (st !== "--") {
    const sameTeam = cands.filter((c) => normalizeTeamAbbrev(c.team) === st);
    if (sameTeam.length === 1) return sameTeam;
    if (sameTeam.length >= 2) {
      const ids = new Set(sameTeam.map((c) => Number(c.mlbId)));
      if (ids.size >= 2) return [];
      return sameTeam;
    }
    const unknownTeam = cands.filter((c) => normalizeTeamAbbrev(c.team) === "--");
    if (unknownTeam.length === 1) return unknownTeam;
    return [];
  }

  const ids = new Set(cands.map((c) => Number(c.mlbId)));
  if (ids.size > 1) return [];
  return cands;
}

export type ShadowPairClassification =
  | "SAFE_EXACT_DUPLICATE"
  | "CONFLICT_REVIEW"
  | "MANUAL_REVIEW_ROLE_MISMATCH";

export function classifyShadowPair(pair: ShadowPair): ShadowPairClassification {
  if (isPitcherPrimaryTokenMismatch(pair.canonical.position, pair.shadow.position)) {
    return "MANUAL_REVIEW_ROLE_MISMATCH";
  }
  const fc = fingerprintConflict(
    projectionFingerprint(pair.canonical.projection),
    projectionFingerprint(pair.shadow.projection)
  );
  if (fc) return "CONFLICT_REVIEW";
  return "SAFE_EXACT_DUPLICATE";
}

/** Same normalized name, ≥2 rows, each with a distinct positive mlbId (different people; not OID shadows). */
export function countSameNameDistinctMlbIdGroups(rows: CatalogIdentityRow[]): number {
  let n = 0;
  for (const [, arr] of groupKeyName(rows)) {
    if (arr.length < 2) continue;
    const ids = new Set(
      arr.filter(hasCanonicalMlbId).map((r) => Number(r.mlbId))
    );
    if (ids.size >= 2) n++;
  }
  return n;
}

/** Same mlbId on multiple Mongo docs (true duplicate identity, not name-only). */
export function findDuplicateMlbIdGroups(rows: CatalogIdentityRow[]): Map<number, CatalogIdentityRow[]> {
  const m = new Map<number, CatalogIdentityRow[]>();
  for (const r of rows) {
    if (!hasCanonicalMlbId(r)) continue;
    const id = Number(r.mlbId);
    if (!m.has(id)) m.set(id, []);
    m.get(id)!.push(r);
  }
  return new Map([...m.entries()].filter(([, arr]) => arr.length > 1));
}

/**
 * Likely shadow duplicate: ObjectId-only catalog row + one unambiguous canonical mlbId row,
 * same normalized name, team-compatible (`--` is unknown, not a conflict with a concrete team),
 * role-compatible (includes P↔RP pitcher family).
 *
 * Never pairs two different non-null mlbIds as shadow/shadow or canonical/canonical.
 * Name alone is never sufficient — mlbId presence + disambiguation rules above are required.
 */
export function findShadowPairs(rows: CatalogIdentityRow[]): ShadowPair[] {
  const withId = rows.filter(hasCanonicalMlbId);
  const out: ShadowPair[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (hasCanonicalMlbId(r)) continue;
    if (!rowUsesObjectIdPlayerId(r)) continue;
    const cands = canonicalCandidatesForShadowOid(r, withId);
    if (cands.length !== 1) continue;
    const canonical = cands[0]!;
    const dedup = `${canonical._id}|${r._id}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    const key = `${normalizePlayerName(r.name)}\t${normalizePrimaryPosition(r.position)}\t${normalizePrimaryPosition(canonical.position)}`;
    out.push({ key, canonical, shadow: r });
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
