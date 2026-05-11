/**
 * First-page season split fetch — **must** match `scripts/sync-players.ts` caps so
 * `buildPlayerDocFromAgg` / projection blends match Mongo rows produced by legacy sync.
 */
import type { MlbStatSplit, SplitAgg } from "./mlbPlayerSyncFromSplits";

export const MLB_SYNC_STATS_HITTING_SPLIT_LIMIT = 400;
export const MLB_SYNC_STATS_PITCHING_SPLIT_LIMIT = 300;

export type MlbStatsSeasonSplitsResponse = {
  stats?: Array<{
    totalSplits?: number;
    splits?: MlbStatSplit[];
  }>;
};

export async function fetchCappedSeasonSplitsLikeSync(options: {
  mlbApiBase: string;
  season: number;
  fetchJson: <T>(url: string) => Promise<T>;
  sportId?: number;
}): Promise<{ batSplits: MlbStatSplit[]; pitSplits: MlbStatSplit[] }> {
  const sportId = options.sportId ?? 1;
  const hit = MLB_SYNC_STATS_HITTING_SPLIT_LIMIT;
  const pit = MLB_SYNC_STATS_PITCHING_SPLIT_LIMIT;
  const [batJson, pitJson] = await Promise.all([
    options.fetchJson<MlbStatsSeasonSplitsResponse>(
      `${options.mlbApiBase}/stats?stats=season&group=hitting&season=${options.season}&playerPool=ALL&limit=${hit}&sportId=${sportId}`
    ),
    options.fetchJson<MlbStatsSeasonSplitsResponse>(
      `${options.mlbApiBase}/stats?stats=season&group=pitching&season=${options.season}&playerPool=ALL&limit=${pit}&sportId=${sportId}`
    ),
  ]);
  return {
    batSplits: batJson.stats?.[0]?.splits ?? [],
    pitSplits: pitJson.stats?.[0]?.splits ?? [],
  };
}

/**
 * Legacy `sync-players` only indexes capped split rows per season (`indexBattingByPlayer` on
 * the first leaderboard page). Missing seasons → `undefined` in `projectBatting` (year skipped).
 *
 * Roster-universe:
 * - Start from capped-only keys (same as sync).
 * - For candidates **not** in `skipFullFallbackForIds`, fill missing seasons from paginated
 *   `fullIdx` (players who never appear on capped leaderboards but are in the roster universe).
 * - For ids in `skipFullFallbackForIds` (anchor-year capped `aggregatePositiveSplits` positives),
 *   **never** attach full-index rows for missing seasons — matches Mongo / legacy blend behavior.
 */
export function buildYearStatIndexCappedWithOptionalFullFallback(options: {
  cappedIdx: Map<number, Record<string, string | number>>;
  fullIdx: Map<number, Record<string, string | number>>;
  candidateMlbIds: ReadonlySet<number>;
  skipFullFallbackForIds: ReadonlySet<number>;
}): Map<number, Record<string, string | number>> {
  const out = new Map(options.cappedIdx);
  for (const id of options.candidateMlbIds) {
    if (options.skipFullFallbackForIds.has(id)) continue;
    if (!out.has(id) && options.fullIdx.has(id)) {
      out.set(id, options.fullIdx.get(id)!);
    }
  }
  return out;
}

/**
 * Anchor `SplitAgg` for roster-universe: prefer capped-page `aggregatePositiveSplits` row
 * when the legacy sync path would see that player; otherwise fall back to full pagination.
 */
export function anchorSplitAggPreferCapped(
  mlbId: number,
  aggCapped: Map<number, SplitAgg>,
  aggFull: Map<number, SplitAgg>
): SplitAgg {
  const c = aggCapped.get(mlbId);
  const f = aggFull.get(mlbId);
  if (c && (c.bat || c.pit)) {
    return {
      bat: c.bat ?? f?.bat,
      pit: c.pit ?? f?.pit,
    };
  }
  return { bat: f?.bat, pit: f?.pit };
}
