/**
 * MLB Stats API season splits and `people` hydrate often omit `team.abbreviation`.
 * `/teams?sportId=1&season=` returns stable `id` → `abbreviation` (e.g. LAD, NYY).
 */

export type MlbTeamRef = { id?: number; abbreviation?: string };

export function resolveMlbTeamAbbrev(
  splitTeam: MlbTeamRef | undefined,
  bioTeam: MlbTeamRef | undefined,
  teamIdToAbbr: ReadonlyMap<number, string>
): string {
  const direct = splitTeam?.abbreviation ?? bioTeam?.abbreviation;
  if (direct) return direct;
  const tid = splitTeam?.id ?? bioTeam?.id;
  if (tid != null) {
    const a = teamIdToAbbr.get(tid);
    if (a) return a;
  }
  return "--";
}
