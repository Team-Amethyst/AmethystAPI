import type { RosterTypeParam } from "./types";

type RosterJson = {
  roster?: { roster?: unknown[] } | unknown[];
};

function extractRosterArray(data: RosterJson): unknown[] {
  const r = data.roster as { roster?: unknown[] } | unknown[] | undefined;
  if (r && typeof r === "object" && "roster" in r && Array.isArray((r as { roster: unknown[] }).roster)) {
    return (r as { roster: unknown[] }).roster;
  }
  if (Array.isArray(r)) return r;
  return [];
}

/**
 * Collect distinct MLB person IDs from team roster endpoint(s).
 */
export async function collectRosterPersonIds(options: {
  mlbApiBase: string;
  teamIds: number[];
  rosterTypes: RosterTypeParam[];
  fetchJson: <T>(url: string) => Promise<T>;
}): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const teamId of options.teamIds) {
    for (const rosterType of options.rosterTypes) {
      const url = `${options.mlbApiBase}/teams/${teamId}/roster?rosterType=${rosterType}`;
      const data = (await options.fetchJson(url)) as RosterJson;
      const arr = extractRosterArray(data);
      for (const entry of arr) {
        const e = entry as { person?: { id?: number } };
        const pid = e.person?.id;
        if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
          ids.add(pid);
        }
      }
    }
  }
  return ids;
}

export async function fetchMlbTeamIds(options: {
  mlbApiBase: string;
  season: number;
  fetchJson: <T>(url: string) => Promise<T>;
  sportId?: number;
}): Promise<number[]> {
  const sportId = options.sportId ?? 1;
  const url = `${options.mlbApiBase}/teams?sportId=${sportId}&season=${options.season}`;
  const data = await options.fetchJson<{ teams?: { id: number }[] }>(url);
  const teams = data.teams ?? [];
  return teams.map((t) => t.id).filter((id) => typeof id === "number" && id > 0);
}
