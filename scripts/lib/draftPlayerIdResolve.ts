/**
 * Resolve spreadsheet player labels → canonical MLB numeric ids for draft export.
 * Used by convert-2026-draft-xlsx (Mongo catalog + MLB Stats API search fallback).
 */

import axios from "axios";

export type CatalogRow = { mlbId: number; name: string; team: string };

export type MatchMethod =
  | "mongo_exact"
  | "mongo_initials_last"
  | "mongo_last_comma_first"
  | "mlb_api_search"
  | "synthetic_unresolved";

export type Resolution = {
  mlbId: number;
  method: MatchMethod;
  /** Human-readable note for logs (candidate count, tie-break, etc.) */
  detail: string;
  /** Canonical display name when known */
  canonicalName?: string;
};

export type ConversionReportEntry = {
  player_id: string;
  sheet_name: string;
  canonical_name?: string;
  team_hint: string;
  match_method: MatchMethod;
  catalog_match_status: "resolved" | "stub";
  detail: string;
  /** Draft pick when from Draft sheet; omit for keepers/minors */
  pick_number?: number;
  context: "draft" | "keeper" | "minors";
};

const MLB_SEARCH = "https://statsapi.mlb.com/api/v1/people/search";

export function normalizeNameKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/['`.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Collapse Jr/Sr/II suffixes so "Fernando Tatis" matches Mongo "Fernando Tatis Jr." */
export function rosterNameKey(raw: string): string {
  let n = normalizeNameKey(sanitizeSheetPlayerName(raw));
  n = n.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "").trim();
  return n;
}

function lastNameKeyFromRoster(raw: string): string {
  const parts = rosterNameKey(raw).split(" ").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : "";
}

/** Known spreadsheet typos → canonical spelling MLB / Mongo uses (lowercase keys). */
const NAME_TYPOS: Record<string, string> = {
  "xander boegarts": "xander bogaerts",
  "alex bohm": "alec bohm",
  "lourdes guerriel": "lourdes gurriel",
  "conor norby": "connor norby",
  "matthew libartore": "matthew liberatore",
  "jake magnum": "jake mangum",
  "willy castro": "willi castro",
};

/** Strip obvious Excel corruption and parenthetical tags. */
export function sanitizeSheetPlayerName(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  // "DTeam D Santana" / "FTeam F Foo" — team label leaked into name column
  s = s.replace(/^[A-Z]Team\s+/i, "").trim();
  // Trailing role/pos in parens: "P. Smith (1B)", "X. Edwards (2/S)"
  s = s.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  const typo = NAME_TYPOS[normalizeNameKey(s)];
  if (typo) {
    return typo
      .split(" ")
      .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(" ");
  }
  return s;
}

function lastNameKey(fullName: string): string {
  return lastNameKeyFromRoster(fullName);
}

function firstInitial(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (!parts.length) return "";
  return parts[0]!.charAt(0).toLowerCase();
}

function teamAbbrevMatches(hint: string, rowTeam: string): boolean {
  if (!hint || hint === "UNK") return false;
  const h = hint.toUpperCase().trim();
  const t = (rowTeam ?? "").toUpperCase().trim();
  return h.length > 0 && t.length > 0 && (t === h || t.startsWith(h) || h.startsWith(t));
}

type PeopleHit = {
  id: number;
  fullName: string;
  isPlayer?: boolean;
  currentTeam?: { abbreviation?: string };
};

function scoreTeamMatch(hit: PeopleHit, teamHint: string): number {
  const ab = hit.currentTeam?.abbreviation?.toUpperCase() ?? "";
  if (!teamHint || teamHint === "UNK") return 0;
  const h = teamHint.toUpperCase();
  return ab === h ? 2 : ab && h && (ab.startsWith(h) || h.startsWith(ab)) ? 1 : 0;
}

/** "N. Arenado" → initial n + last arenado */
/** Single leading initial + remainder (may be multi-word, e.g. "de la cruz"). */
export function parseInitialLastPattern(norm: string): { initial: string; lastRest: string } | null {
  const m = /^([a-z])\.?\s+(.+)$/i.exec(norm.trim());
  if (!m) return null;
  const tail = m[2]!.trim().replace(/\s+/g, " ");
  if (!tail) return null;
  return { initial: m[1]!.toLowerCase(), lastRest: tail };
}

/** "Smith, John" */
function parseLastCommaFirst(norm: string): { lastKey: string; firstKey: string } | null {
  const m = /^([^,]+),\s*([a-z]+)/i.exec(norm);
  if (!m) return null;
  return { lastKey: m[1]!.trim().toLowerCase(), firstKey: m[2]!.trim().toLowerCase() };
}

function candidatesFromInitialLast(
  rows: CatalogRow[],
  initial: string,
  lastRest: string
): CatalogRow[] {
  const parts = lastRest.split(" ").filter(Boolean);
  const lastToken = parts.length ? parts[parts.length - 1]! : lastRest;
  return rows.filter((r) => {
    if (lastNameKey(r.name) !== lastToken) return false;
    return firstInitial(r.name) === initial;
  });
}

function candidatesFromLastFirst(rows: CatalogRow[], lastKey: string, firstKey: string): CatalogRow[] {
  return rows.filter((r) => {
    const parts = rosterNameKey(r.name).split(" ").filter(Boolean);
    if (parts.length < 2) return false;
    const lk = parts[parts.length - 1]!;
    const fk = parts[0]!;
    return lk === lastKey && fk.startsWith(firstKey);
  });
}

function pickWithTeamHint(cands: CatalogRow[], teamHint: string): CatalogRow | null {
  if (cands.length === 1) return cands[0]!;
  const scored = cands.map((c) => ({
    c,
    s: teamAbbrevMatches(teamHint, c.team) ? 1 : 0,
  }));
  scored.sort((a, b) => b.s - a.s || a.c.mlbId - b.c.mlbId);
  if (scored[0]!.s > 0 || cands.length === 1) return scored[0]!.c;
  return scored[0]!.c;
}

/**
 * Resolve one display string to an mlbId using in-memory catalog only.
 */
export function resolveAgainstCatalog(
  sheetName: string,
  teamHint: string,
  catalog: CatalogRow[]
): Resolution | null {
  const san = sanitizeSheetPlayerName(sheetName);
  const norm = normalizeNameKey(san);
  if (!norm) return null;

  const sheetRk = rosterNameKey(sheetName);
  const exact = catalog.filter((r) => rosterNameKey(r.name) === sheetRk);
  if (exact.length) {
    const row = pickWithTeamHint(exact, teamHint);
    if (row) {
      return {
        mlbId: row.mlbId,
        method: "mongo_exact",
        detail: `exact name match among ${exact.length} candidate(s)`,
        canonicalName: row.name,
      };
    }
  }

  const lcf = parseLastCommaFirst(norm);
  if (lcf) {
    const cands = candidatesFromLastFirst(catalog, lcf.lastKey, lcf.firstKey);
    if (cands.length) {
      const row = pickWithTeamHint(cands, teamHint);
      if (row) {
        return {
          mlbId: row.mlbId,
          method: "mongo_last_comma_first",
          detail: `last, first pattern; ${cands.length} candidate(s)`,
          canonicalName: row.name,
        };
      }
    }
  }

  const il = parseInitialLastPattern(norm);
  if (il) {
    const cands = candidatesFromInitialLast(catalog, il.initial, il.lastRest);
    if (cands.length) {
      const row = pickWithTeamHint(cands, teamHint);
      if (row) {
        return {
          mlbId: row.mlbId,
          method: "mongo_initials_last",
          detail: `initial+last pattern; ${cands.length} candidate(s)`,
          canonicalName: row.name,
        };
      }
    }
  }

  return null;
}

/**
 * MLB Stats API fallback when catalog match fails. Throttle externally if needed.
 */
export async function resolveViaMlbSearch(
  sheetName: string,
  teamHint: string
): Promise<Resolution | null> {
  const san = sanitizeSheetPlayerName(sheetName);
  const norm = normalizeNameKey(san);
  if (!norm) return null;

  const tryNames: string[] = [san];
  const il = parseInitialLastPattern(norm);
  if (il) {
    const tok = il.lastRest.split(" ").filter(Boolean).pop() ?? il.lastRest;
    tryNames.push(tok);
  }

  for (const q of tryNames) {
    try {
      const { data } = await axios.get<{ people?: PeopleHit[] }>(MLB_SEARCH, {
        params: { names: q },
        timeout: 15000,
      });
      let people = data.people ?? [];
      people = people.filter((p) => p.isPlayer !== false);
      if (!people.length) continue;
      const ranked = [...people].sort(
        (a, b) => scoreTeamMatch(b, teamHint) - scoreTeamMatch(a, teamHint) || a.id - b.id
      );
      const hit = ranked[0]!;
      return {
        mlbId: hit.id,
        method: "mlb_api_search",
        detail: `MLB search q=${JSON.stringify(q)}; hits=${people.length}; picked=${hit.fullName}`,
        canonicalName: hit.fullName,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function nextSyntheticMlbId(counter: { n: number }): number {
  counter.n += 1;
  return 9_000_000 + counter.n;
}

/**
 * Stable cross-sheet key: last name + first initial (so "N. Arenado" and "Nolan Arenado" merge).
 * Collision risk for same-last same-initial different players (rare in one league export).
 */
export function rosterIdentityKey(rawName: string): string {
  const norm = rosterNameKey(rawName);
  if (!norm) return "";
  // Placeholder rows when a "Team X" header is mis-read as a player name
  if (/^team [a-z]$/i.test(norm)) return "";

  const il = parseInitialLastPattern(norm);
  if (il) {
    const tok = il.lastRest.split(" ").filter(Boolean).pop() ?? il.lastRest;
    return `${tok}:${il.initial}`;
  }

  const parts = norm.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    const first = parts[0]!;
    return `${last}:${first.charAt(0)}`;
  }
  return norm;
}
