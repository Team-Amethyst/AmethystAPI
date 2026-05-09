import type { LeanPlayer } from "../types/brain";

const MLB_API = "https://statsapi.mlb.com/api/v1";

/** Team strings that cannot be mapped to AL/NL without an MLB lookup. */
const PLACEHOLDER_TEAMS = new Set([
  "",
  "--",
  "-",
  "FA",
  "F/A",
  "TBD",
  "UNK",
  "UNKNOWN",
  "N/A",
  "NA",
  "?",
  "???",
]);

export function isPlaceholderCatalogTeam(team: string | undefined): boolean {
  if (team == null) return true;
  const t = team.trim().toUpperCase();
  return PLACEHOLDER_TEAMS.has(t);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json() as Promise<T>;
}

let cachedTeamIdToAbbr: { season: number; map: Map<number, string> } | null =
  null;

/** Clears in-process team map cache (tests only). */
export function resetMlbTeamAbbrevCacheForTests(): void {
  cachedTeamIdToAbbr = null;
}

export async function fetchMlbTeamIdToAbbrev(
  season: number
): Promise<Map<number, string>> {
  if (cachedTeamIdToAbbr?.season === season) {
    return cachedTeamIdToAbbr.map;
  }
  const teamsJson = await fetchJson<{
    teams: { id: number; abbreviation: string }[];
  }>(`${MLB_API}/teams?sportId=1&season=${season}`);
  const map = new Map<number, string>();
  for (const t of teamsJson.teams ?? []) {
    map.set(t.id, t.abbreviation);
  }
  cachedTeamIdToAbbr = { season, map };
  return map;
}

type MlbPerson = {
  id: number;
  currentTeam?: { id?: number; abbreviation?: string };
};

async function fetchPeopleCurrentTeamIds(
  personIds: number[]
): Promise<Map<number, number | undefined>> {
  const out = new Map<number, number | undefined>();
  if (personIds.length === 0) return out;
  const bioJson = await fetchJson<{ people: MlbPerson[] }>(
    `${MLB_API}/people?personIds=${personIds.join(",")}&hydrate=currentTeam`
  );
  for (const p of bioJson.people ?? []) {
    const tid = p.currentTeam?.id;
    out.set(p.id, tid);
  }
  return out;
}

const DEFAULT_CHUNK = 120;

export type HydrateCatalogTeamsResult = {
  players: LeanPlayer[];
  hydratedCount: number;
  skippedCount: number;
};

/**
 * Fills placeholder `team` values on catalog rows using MLB Stats API
 * `people` + `teams` maps (same contract as `sync-players`).
 */
export async function hydratePlaceholderCatalogTeamsFromMlb(
  players: LeanPlayer[],
  options?: {
    season?: number;
    chunkSize?: number;
    log?: (message: string) => void;
  }
): Promise<HydrateCatalogTeamsResult> {
  const season =
    options?.season ?? new Date().getFullYear() - 1;
  const chunk = options?.chunkSize ?? DEFAULT_CHUNK;
  const log = options?.log;

  const needIds = [
    ...new Set(
      players
        .filter((p) => isPlaceholderCatalogTeam(p.team) && p.mlbId != null)
        .map((p) => p.mlbId as number)
    ),
  ];
  if (needIds.length === 0) {
    return { players, hydratedCount: 0, skippedCount: 0 };
  }

  const teamIdToAbbr = await fetchMlbTeamIdToAbbrev(season);
  const personToTeamId = new Map<number, number | undefined>();
  for (let i = 0; i < needIds.length; i += chunk) {
    const slice = needIds.slice(i, i + chunk);
    const part = await fetchPeopleCurrentTeamIds(slice);
    for (const [k, v] of part) personToTeamId.set(k, v);
  }

  let hydratedCount = 0;
  let skippedCount = 0;
  const out: LeanPlayer[] = players.map((p) => {
    if (!isPlaceholderCatalogTeam(p.team) || p.mlbId == null) {
      return p;
    }
    const tid = personToTeamId.get(p.mlbId);
    if (tid == null) {
      skippedCount += 1;
      return p;
    }
    const abbr = teamIdToAbbr.get(tid);
    if (!abbr) {
      skippedCount += 1;
      return p;
    }
    hydratedCount += 1;
    return { ...p, team: abbr };
  });

  log?.(
    `[catalogTeamHydration] season=${season} hydrated=${hydratedCount} skipped=${skippedCount} (placeholders with mlbId=${needIds.length})`
  );

  return { players: out, hydratedCount, skippedCount };
}
