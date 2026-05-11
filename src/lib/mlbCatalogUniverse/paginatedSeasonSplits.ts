import type { MlbStatSplit } from "../mlbPlayerSyncFromSplits";

export type MlbStatsSeasonResponse = {
  stats?: Array<{
    totalSplits?: number;
    splits?: MlbStatSplit[];
  }>;
};

/**
 * Fetches all season splits for a group/season by paging with `offset` until MLB reports are exhausted.
 * Avoid relying on a single capped leaderboard page as the player universe.
 */
export async function fetchAllSeasonSplitsPaginated(options: {
  mlbApiBase: string;
  season: number;
  group: "hitting" | "pitching";
  pageSize: number;
  fetchJson: <T>(url: string) => Promise<T>;
  sportId?: number;
}): Promise<MlbStatSplit[]> {
  const sportId = options.sportId ?? 1;
  const out: MlbStatSplit[] = [];
  let offset = 0;
  let totalSplits = Number.POSITIVE_INFINITY;
  let pages = 0;

  while (offset < totalSplits) {
    pages++;
    if (pages > 120) {
      throw new Error(
        `MLB stats pagination exceeded safety cap (group=${options.group}, season=${options.season})`
      );
    }
    const offParam = offset > 0 ? `&offset=${offset}` : "";
    const url = `${options.mlbApiBase}/stats?stats=season&group=${options.group}&season=${options.season}&playerPool=ALL&limit=${options.pageSize}&sportId=${sportId}${offParam}`;
    const json = await options.fetchJson<MlbStatsSeasonResponse>(url);
    const stat0 = json.stats?.[0];
    if (stat0?.totalSplits != null && Number.isFinite(stat0.totalSplits)) {
      totalSplits = stat0.totalSplits;
    }
    const splits = stat0?.splits ?? [];
    if (splits.length === 0) break;
    out.push(...splits);
    offset += splits.length;
    if (splits.length < options.pageSize) break;
    if (Number.isFinite(totalSplits) && out.length >= totalSplits) break;
  }

  return out;
}
