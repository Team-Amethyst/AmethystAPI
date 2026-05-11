import { calcAge } from "../mlbSyncFormulas";
import type { MlbPlayer, MlbStatSplit, PlayerSyncDoc } from "../mlbPlayerSyncFromSplits";
import {
  aggregatePositiveSplits,
  assignCatalogRankByValue,
  buildPlayerDocFromAgg,
  indexBattingByPlayer,
  indexPitchingByPlayer,
} from "../mlbPlayerSyncFromSplits";
import {
  anchorSplitAggPreferCapped,
  buildYearStatIndexCappedWithOptionalFullFallback,
  fetchCappedSeasonSplitsLikeSync,
  MLB_SYNC_STATS_HITTING_SPLIT_LIMIT,
  MLB_SYNC_STATS_PITCHING_SPLIT_LIMIT,
} from "../mlbSyncCappedSeasonSplits";
import { resolveMlbTeamAbbrev } from "../mlbTeamResolve";
import { extractNfbcMlbIdsFromMarketPreview } from "./nfbcCandidateIds";
import { fetchAllSeasonSplitsPaginated } from "./paginatedSeasonSplits";
import { collectRosterPersonIds, fetchMlbTeamIds } from "./rosterCandidates";
import { CATALOG_UNIVERSE_SPOTLIGHT_AUDIT } from "./spotlightAuditTargets";
import type { CatalogUniverseDryRunReport, RosterTypeParam } from "./types";

export type ExistingPlayerMarketFields = {
  market_adp?: number;
  market_adp_source?: string;
  market_adp_updated_at?: string;
  market_adp_min?: number;
  market_adp_max?: number;
  market_pick_count?: number;
};

export type RunRosterCatalogUniverseBuildOptions = {
  mlbApiBase: string;
  lastCompletedSeason: number;
  fetchJson: <T>(url: string) => Promise<T>;
  /** Page size for paginated stats (MLB supports offset paging). */
  statsPageSize: number;
  rosterTypes: RosterTypeParam[];
  /** Optional NFBC preview JSON (dry-run market ingest output). */
  nfbcPreviewJson?: unknown;
  /** MLB IDs already carrying market ADP in Mongo (merged into candidate set). */
  nfbcMlbIdsFromMongo?: Set<number>;
  /** Preserve vendor fields when rewriting an existing row. */
  existingMarketByMlbId?: Map<number, ExistingPlayerMarketFields>;
};

function hasMeaningfulProjection(projection: Record<string, unknown>): boolean {
  const bat = projection.batting as Record<string, unknown> | undefined;
  const pit = projection.pitching as Record<string, unknown> | undefined;
  if (bat && Object.keys(bat).length > 0) return true;
  if (pit && Object.keys(pit).length > 0) return true;
  return false;
}

async function fetchBioMapChunked(options: {
  mlbApiBase: string;
  ids: number[];
  fetchJson: <T>(url: string) => Promise<T>;
  chunkSize?: number;
}): Promise<Map<number, MlbPlayer>> {
  const bioMap = new Map<number, MlbPlayer>();
  const chunk = options.chunkSize ?? 200;
  for (let i = 0; i < options.ids.length; i += chunk) {
    const slice = options.ids.slice(i, i + chunk);
    if (slice.length === 0) continue;
    try {
      const url = `${options.mlbApiBase}/people?personIds=${slice.join(",")}&hydrate=currentTeam`;
      const bioJson = await options.fetchJson<{ people?: MlbPlayer[] }>(url);
      for (const p of bioJson.people ?? []) {
        bioMap.set(p.id, p);
      }
    } catch {
      // non-fatal — names may degrade to Unknown
    }
  }
  return bioMap;
}

async function fetchTeamAbbrevMap(options: {
  mlbApiBase: string;
  season: number;
  fetchJson: <T>(url: string) => Promise<T>;
}): Promise<Map<number, string>> {
  const url = `${options.mlbApiBase}/teams?sportId=1&season=${options.season}`;
  const teamsJson = await options.fetchJson<{ teams?: { id: number; abbreviation: string }[] }>(url);
  const teamIdToAbbr = new Map<number, string>();
  for (const t of teamsJson.teams ?? []) {
    teamIdToAbbr.set(t.id, t.abbreviation);
  }
  return teamIdToAbbr;
}

async function fetchCappedFirstPageSplitIds(options: {
  mlbApiBase: string;
  season: number;
  fetchJson: <T>(url: string) => Promise<T>;
}): Promise<{ bat: Set<number>; pit: Set<number> }> {
  const batUrl = `${options.mlbApiBase}/stats?stats=season&group=hitting&season=${options.season}&playerPool=ALL&limit=${MLB_SYNC_STATS_HITTING_SPLIT_LIMIT}&sportId=1`;
  const pitUrl = `${options.mlbApiBase}/stats?stats=season&group=pitching&season=${options.season}&playerPool=ALL&limit=${MLB_SYNC_STATS_PITCHING_SPLIT_LIMIT}&sportId=1`;
  const [batJson, pitJson] = await Promise.all([
    options.fetchJson<{ stats?: { splits?: MlbStatSplit[] }[] }>(batUrl),
    options.fetchJson<{ stats?: { splits?: MlbStatSplit[] }[] }>(pitUrl),
  ]);
  const bat = new Set<number>();
  const pit = new Set<number>();
  for (const s of batJson.stats?.[0]?.splits ?? []) {
    bat.add(s.player.id);
  }
  for (const s of pitJson.stats?.[0]?.splits ?? []) {
    pit.add(s.player.id);
  }
  return { bat, pit };
}

function buildMinimalTierDoc(args: {
  mlbId: number;
  bio: MlbPlayer | undefined;
  teamIdToAbbr: Map<number, string>;
  tier: "market_only" | "roster_context";
  market?: ExistingPlayerMarketFields;
}): PlayerSyncDoc {
  const team = resolveMlbTeamAbbrev(undefined, args.bio?.currentTeam, args.teamIdToAbbr);
  const position = args.bio?.primaryPosition?.abbreviation ?? "UNK";
  const doc: PlayerSyncDoc = {
    mlbId: args.mlbId,
    catalogKind: "mlb",
    name: args.bio?.fullName ?? "Unknown",
    team,
    position,
    age: calcAge(args.bio?.birthDate),
    value: 0,
    catalog_tier: 0,
    stats: {},
    projection: {},
    outlook: "",
    catalogValuationTier: args.tier,
    catalog_rank: 9999,
  };
  if (args.market?.market_adp != null) doc.market_adp = args.market.market_adp;
  if (args.market?.market_adp_source != null) doc.market_adp_source = args.market.market_adp_source;
  if (args.market?.market_adp_updated_at != null) {
    doc.market_adp_updated_at = args.market.market_adp_updated_at;
  }
  if (args.market?.market_adp_min != null) doc.market_adp_min = args.market.market_adp_min;
  if (args.market?.market_adp_max != null) doc.market_adp_max = args.market.market_adp_max;
  if (args.market?.market_pick_count != null) doc.market_pick_count = args.market.market_pick_count;
  return doc;
}

/**
 * Roster + NFBC candidate universe: merge roster and optional NFBC MLB IDs, attach bios, classify
 * valuation tiers, and build `PlayerSyncDoc` rows via `buildPlayerDocFromAgg`.
 *
 * **Season stats / projection parity with legacy `sync-players`:**
 * - For each of the three blend seasons, the builder loads **capped** first-page stats (same limits
 *   as sync) **and** **paginated** season splits so players missing from the global leaderboard still
 *   appear in the roster-expanded universe.
 * - Per-season batting/pitching maps are **`buildYearStatIndexCappedWithOptionalFullFallback`**: start
 *   from capped indexes; paginated rows fill a season **only** for candidate MLB IDs **not** listed in
 *   `skipFullFallbackForIds` (the set of keys from anchor-year capped `aggregatePositiveSplits`).
 *   Anchor-capped players therefore keep **capped-first** behavior: if capped has no row for a prior
 *   year, that year stays absent — matching legacy `projectBatting` / `projectPitching` (year skipped).
 * - Anchor split aggregation prefers capped when the player has positive capped stats
 *   (`anchorSplitAggPreferCapped`).
 *
 * **Mongo:** this function does not write. CLI upserts remain gated by
 * `sync-players --roster-universe-v1 --confirm-universe-write` (no `--dry-run`).
 */
export async function runRosterCatalogUniverseBuild(
  options: RunRosterCatalogUniverseBuildOptions
): Promise<{ report: CatalogUniverseDryRunReport; players: PlayerSyncDoc[] }> {
  const last = options.lastCompletedSeason;
  const seasons = [last, last - 1, last - 2] as const;
  const teamIds = await fetchMlbTeamIds({
    mlbApiBase: options.mlbApiBase,
    season: last,
    fetchJson: options.fetchJson,
  });
  const rosterIds = await collectRosterPersonIds({
    mlbApiBase: options.mlbApiBase,
    teamIds,
    rosterTypes: options.rosterTypes,
    fetchJson: options.fetchJson,
  });

  const nfbcFromPreview =
    options.nfbcPreviewJson != null
      ? extractNfbcMlbIdsFromMarketPreview(options.nfbcPreviewJson)
      : new Set<number>();
  const nfbcFromMongo = options.nfbcMlbIdsFromMongo ?? new Set<number>();

  const nfbcMerged = new Set<number>([...nfbcFromPreview, ...nfbcFromMongo]);
  const candidates = new Set<number>([...rosterIds, ...nfbcMerged]);

  let rosterOnly = 0;
  let nfbcOnly = 0;
  let overlapRosterNfbcPreview = 0;
  let overlapRosterNfbcTotal = 0;
  for (const id of rosterIds) {
    if (nfbcFromPreview.has(id)) overlapRosterNfbcPreview++;
    if (nfbcMerged.has(id)) overlapRosterNfbcTotal++;
  }
  for (const id of candidates) {
    const onR = rosterIds.has(id);
    const onN = nfbcMerged.has(id);
    if (onR && !onN) rosterOnly++;
    if (!onR && onN) nfbcOnly++;
  }

  const yearBat = new Map<number, Map<number, Record<string, string | number>>>();
  const yearPit = new Map<number, Map<number, Record<string, string | number>>>();

  type SeasonSplitBundle = {
    season: number;
    capBat: MlbStatSplit[];
    capPit: MlbStatSplit[];
    fullBat: MlbStatSplit[];
    fullPit: MlbStatSplit[];
  };
  const perSeason: SeasonSplitBundle[] = [];
  for (const se of seasons) {
    const { batSplits: capBat, pitSplits: capPit } = await fetchCappedSeasonSplitsLikeSync({
      mlbApiBase: options.mlbApiBase,
      season: se,
      fetchJson: options.fetchJson,
    });
    const fullBat = await fetchAllSeasonSplitsPaginated({
      mlbApiBase: options.mlbApiBase,
      season: se,
      group: "hitting",
      pageSize: options.statsPageSize,
      fetchJson: options.fetchJson,
    });
    const fullPit = await fetchAllSeasonSplitsPaginated({
      mlbApiBase: options.mlbApiBase,
      season: se,
      group: "pitching",
      pageSize: options.statsPageSize,
      fetchJson: options.fetchJson,
    });
    perSeason.push({ season: se, capBat, capPit, fullBat, fullPit });
  }

  const anchorBundle = perSeason.find((b) => b.season === last);
  if (!anchorBundle) {
    throw new Error("roster catalog universe: missing anchor season split bundle");
  }
  const anchorAggCapped = aggregatePositiveSplits(anchorBundle.capBat, anchorBundle.capPit);
  const anchorAggFull = aggregatePositiveSplits(anchorBundle.fullBat, anchorBundle.fullPit);
  const skipFullFallbackForIds = new Set(anchorAggCapped.keys());

  for (const b of perSeason) {
    yearBat.set(
      b.season,
      buildYearStatIndexCappedWithOptionalFullFallback({
        cappedIdx: indexBattingByPlayer(b.capBat),
        fullIdx: indexBattingByPlayer(b.fullBat),
        candidateMlbIds: candidates,
        skipFullFallbackForIds,
      })
    );
    yearPit.set(
      b.season,
      buildYearStatIndexCappedWithOptionalFullFallback({
        cappedIdx: indexPitchingByPlayer(b.capPit),
        fullIdx: indexPitchingByPlayer(b.fullPit),
        candidateMlbIds: candidates,
        skipFullFallbackForIds,
      })
    );
  }

  const teamIdToAbbr = await fetchTeamAbbrevMap({
    mlbApiBase: options.mlbApiBase,
    season: last,
    fetchJson: options.fetchJson,
  });

  const capped = await fetchCappedFirstPageSplitIds({
    mlbApiBase: options.mlbApiBase,
    season: last,
    fetchJson: options.fetchJson,
  });

  const allIds = [...candidates].sort((a, b) => a - b);
  const bioMap = await fetchBioMapChunked({
    mlbApiBase: options.mlbApiBase,
    ids: allIds,
    fetchJson: options.fetchJson,
  });

  const playersOut: PlayerSyncDoc[] = [];
  let valuationEligible = 0;
  let marketOnly = 0;
  let rosterContext = 0;
  let missingProjection = 0;
  let anchorStatsAbsent = 0;

  const newlyVsCapped: number[] = [];

  for (const mlbId of allIds) {
    const agg = anchorSplitAggPreferCapped(mlbId, anchorAggCapped, anchorAggFull);
    if (!agg.bat && !agg.pit) anchorStatsAbsent++;
    const bio = bioMap.get(mlbId);
    const existingMarket = options.existingMarketByMlbId?.get(mlbId);
    const hasMarketSignal =
      (existingMarket?.market_adp != null && Number.isFinite(existingMarket.market_adp)) ||
      nfbcMerged.has(mlbId);

    const fullDoc = buildPlayerDocFromAgg(
      mlbId,
      agg,
      bio,
      teamIdToAbbr,
      yearBat,
      yearPit,
      last
    );

    if (fullDoc) {
      const tiered: PlayerSyncDoc = {
        ...fullDoc,
        catalogValuationTier: "valuation_eligible",
      };
      if (existingMarket?.market_adp != null) tiered.market_adp = existingMarket.market_adp;
      if (existingMarket?.market_adp_source != null) {
        tiered.market_adp_source = existingMarket.market_adp_source;
      }
      if (existingMarket?.market_adp_updated_at != null) {
        tiered.market_adp_updated_at = existingMarket.market_adp_updated_at;
      }
      if (existingMarket?.market_adp_min != null) tiered.market_adp_min = existingMarket.market_adp_min;
      if (existingMarket?.market_adp_max != null) tiered.market_adp_max = existingMarket.market_adp_max;
      if (existingMarket?.market_pick_count != null) {
        tiered.market_pick_count = existingMarket.market_pick_count;
      }
      playersOut.push(tiered);
      valuationEligible++;
      if (!hasMeaningfulProjection(fullDoc.projection)) missingProjection++;
    } else if (hasMarketSignal) {
      playersOut.push(
        buildMinimalTierDoc({
          mlbId,
          bio,
          teamIdToAbbr,
          tier: "market_only",
          market: existingMarket,
        })
      );
      marketOnly++;
      missingProjection++;
    } else {
      playersOut.push(
        buildMinimalTierDoc({
          mlbId,
          bio,
          teamIdToAbbr,
          tier: "roster_context",
          market: existingMarket,
        })
      );
      rosterContext++;
      missingProjection++;
    }

    const onCappedPage = capped.bat.has(mlbId) || capped.pit.has(mlbId);
    if (!onCappedPage && candidates.has(mlbId) && newlyVsCapped.length < 40) {
      newlyVsCapped.push(mlbId);
    }
  }

  let newlyNotOnCappedFirstPage = 0;
  for (const id of candidates) {
    if (!capped.bat.has(id) && !capped.pit.has(id)) newlyNotOnCappedFirstPage++;
  }

  const byMlbId = new Map(playersOut.map((p) => [p.mlbId, p]));
  const spotlight_players = CATALOG_UNIVERSE_SPOTLIGHT_AUDIT.map(({ mlbId, label }) => {
    const row = byMlbId.get(mlbId);
    return {
      label,
      mlbId,
      in_roster_pool: rosterIds.has(mlbId),
      in_nfbc_preview_pool: nfbcFromPreview.has(mlbId),
      in_candidate_universe: candidates.has(mlbId),
      catalogValuationTier: row?.catalogValuationTier,
      absent_from_capped_seed_first_page: !capped.bat.has(mlbId) && !capped.pit.has(mlbId),
      name_from_catalog: row?.name,
    };
  });

  const rankedValuation = assignCatalogRankByValue(
    playersOut.filter((p) => p.catalogValuationTier === "valuation_eligible")
  );
  const rankById = new Map<number, number>();
  for (const p of rankedValuation) {
    if (typeof p.catalog_rank === "number") rankById.set(p.mlbId, p.catalog_rank);
  }
  for (const p of playersOut) {
    if (p.catalogValuationTier === "valuation_eligible") {
      const r = rankById.get(p.mlbId);
      if (r != null) p.catalog_rank = r;
    }
  }

  const report: CatalogUniverseDryRunReport = {
    generatedAt: new Date().toISOString(),
    anchor_season: last,
    blend_seasons: [...seasons],
    roster_types_used: options.rosterTypes,
    candidate_count: candidates.size,
    roster_candidate_count: rosterIds.size,
    nfbc_preview_candidate_count: nfbcFromPreview.size,
    nfbc_mongo_candidate_count: nfbcFromMongo.size,
    overlap_roster_nfbc_preview_count: overlapRosterNfbcPreview,
    overlap_roster_nfbc_total_count: overlapRosterNfbcTotal,
    roster_only_count: rosterOnly,
    nfbc_only_count: nfbcOnly,
    valuation_eligible_count: valuationEligible,
    market_only_count: marketOnly,
    roster_context_count: rosterContext,
    missing_projection_count: missingProjection,
    anchor_stats_absent_count: anchorStatsAbsent,
    newly_included_not_on_capped_first_page_count: newlyNotOnCappedFirstPage,
    newly_included_vs_capped_seed_sample: newlyVsCapped,
    spotlight_players,
  };

  return { report, players: playersOut };
}
