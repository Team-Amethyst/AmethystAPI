/**
 * Sync script — fetches live player data from the MLB Stats API and upserts
 * into the `players` collection by canonical **mlbId** only (`catalogKind: "mlb"`).
 *
 * Run:
 *   pnpm sync-players
 *   pnpm sync-players -- --dry-run
 *   pnpm sync-players -- --dry-run --rebuild-catalog
 *   pnpm sync-players -- --rebuild-catalog --confirm-destructive   # dedupe + remove invalid
 *   pnpm sync-players -- --skip-sync --rebuild-catalog --dry-run
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import {
  assignTier,
  calcAge,
  calcBatterValue,
  calcPitcherValue,
} from "../src/lib/mlbSyncFormulas";
import { projectBatting, projectPitching } from "../src/lib/mlbProjectionBlend";
import { resolveMlbTeamAbbrev } from "../src/lib/mlbTeamResolve";
import Player from "../src/models/Player";
import { classifyCatalogDoc } from "../src/lib/catalogRowClassification";
import type { CatalogIdentityRow } from "../src/lib/catalogIdentityHelpers";
import { findDuplicateMlbIdGroups } from "../src/lib/catalogIdentityHelpers";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { collectProjectionSanityIssues } from "../src/lib/projectionSanity";
import {
  runSyncQualityGates,
  sameNameDistinctMlbIdWarning,
} from "../src/lib/syncQualityGates";
import { getPlayerId } from "../src/lib/playerId";
import { PLAYER_CATALOG_LEAN_SELECT } from "../src/lib/playerCatalogProjection";

dotenv.config();

const ROOT = path.resolve(__dirname, "..");
const MLB_API = "https://statsapi.mlb.com/api/v1";
const LAST_COMPLETED_SEASON = new Date().getFullYear() - 1;

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI not set in .env");
  process.exit(1);
}

interface MlbPlayer {
  id: number;
  fullName: string;
  currentTeam?: { id?: number; abbreviation?: string };
  primaryPosition?: { abbreviation: string };
  birthDate?: string;
}

type SplitAgg = {
  bat?: MlbStatSplit;
  pit?: MlbStatSplit;
};

type PlayerSyncDoc = {
  mlbId: number;
  catalogKind: "mlb";
  name: string;
  team: string;
  position: string;
  positions?: string[];
  age: number;
  depthChartPosition?: number;
  value: number;
  catalog_tier: number;
  stats: Record<string, unknown>;
  projection: Record<string, unknown>;
  outlook: string;
  catalog_rank?: number;
  catalogMeta?: {
    stats_season: number;
    projection_blend_seasons: number[];
  };
};

type SyncCli = {
  dryRun: boolean;
  rebuildCatalog: boolean;
  confirmDestructive: boolean;
  skipSync: boolean;
  failOnGate: boolean;
  archiveInvalid: boolean;
};

function parseArgs(argv: string[]): SyncCli {
  const a = new Set(argv.filter((x) => x !== "--"));
  return {
    dryRun: a.has("--dry-run") || a.has("--dryRun"),
    rebuildCatalog: a.has("--rebuild-catalog") || a.has("--rebuildCatalog"),
    confirmDestructive: a.has("--confirm-destructive") || a.has("--confirmDestructive"),
    skipSync: a.has("--skip-sync") || a.has("--skipSync"),
    failOnGate: !a.has("--no-fail-gates"),
    archiveInvalid: a.has("--archive-invalid"),
  };
}

function addMlbPositionAbbrev(set: Set<string>, abbrev?: string): void {
  if (!abbrev) return;
  const u = abbrev.trim().toUpperCase();
  if (u === "TWP") {
    set.add("DH");
    set.add("SP");
  } else if (u.length > 0) {
    set.add(u);
  }
}

function buildPlayerDocFromAgg(
  mlbId: number,
  agg: SplitAgg,
  bio: MlbPlayer | undefined,
  teamIdToAbbr: Map<number, string>,
  yearBat: Map<number, Map<number, Record<string, string | number>>>,
  yearPit: Map<number, Map<number, Record<string, string | number>>>,
  lastSeason: number
): PlayerSyncDoc | null {
  const batVal = agg.bat ? calcBatterValue(agg.bat.stat) : 0;
  const pitVal = agg.pit ? calcPitcherValue(agg.pit.stat) : 0;
  if (batVal <= 0 && pitVal <= 0) return null;

  const value = Math.max(batVal, pitVal);
  const team = resolveMlbTeamAbbrev(
    agg.bat?.team ?? agg.pit?.team,
    bio?.currentTeam,
    teamIdToAbbr
  );

  const posSet = new Set<string>();
  addMlbPositionAbbrev(posSet, agg.bat?.position?.abbreviation);
  addMlbPositionAbbrev(posSet, agg.pit?.position?.abbreviation);
  addMlbPositionAbbrev(posSet, bio?.primaryPosition?.abbreviation);

  const primaryBio = bio?.primaryPosition?.abbreviation?.trim().toUpperCase();
  let position: string;
  if (primaryBio === "TWP") {
    position = batVal >= pitVal ? "DH" : "SP";
  } else if (agg.bat && !agg.pit) {
    position =
      agg.bat.position?.abbreviation ??
      bio?.primaryPosition?.abbreviation ??
      "OF";
  } else if (agg.pit && !agg.bat) {
    position =
      agg.pit.position?.abbreviation ??
      bio?.primaryPosition?.abbreviation ??
      "SP";
  } else if (agg.bat && agg.pit) {
    position =
      batVal >= pitVal
        ? agg.bat.position?.abbreviation ?? "DH"
        : agg.pit.position?.abbreviation ?? "SP";
  } else {
    position = bio?.primaryPosition?.abbreviation ?? "OF";
  }

  const positions = [...posSet].filter((p) => p !== position);

  const stats: Record<string, unknown> = {};
  if (agg.bat) {
    const stat = agg.bat.stat;
    stats.batting = {
      avg: String(stat.avg ?? ".000"),
      hr: Number(stat.homeRuns ?? 0),
      rbi: Number(stat.rbi ?? 0),
      runs: Number(stat.runs ?? 0),
      sb: Number(stat.stolenBases ?? 0),
      obp: String(stat.obp ?? ".000"),
      slg: String(stat.slg ?? ".000"),
    };
  }
  if (agg.pit) {
    const stat = agg.pit.stat;
    stats.pitching = {
      era: String(stat.era ?? "0.00"),
      whip: String(stat.whip ?? "0.00"),
      wins: Number(stat.wins ?? 0),
      saves: Number(stat.saves ?? 0),
      strikeouts: Number(stat.strikeOuts ?? 0),
      innings: String(stat.inningsPitched ?? "0"),
    };
  }

  const y2 = lastSeason - 1;
  const y3 = lastSeason - 2;
  const bat1 = yearBat.get(lastSeason)?.get(mlbId);
  const bat2 = yearBat.get(y2)?.get(mlbId);
  const bat3 = yearBat.get(y3)?.get(mlbId);
  const pit1 = yearPit.get(lastSeason)?.get(mlbId);
  const pit2 = yearPit.get(y2)?.get(mlbId);
  const pit3 = yearPit.get(y3)?.get(mlbId);

  const blendedBat = projectBatting(bat1, bat2, bat3);
  const blendedPit = projectPitching(pit1, pit2, pit3);

  const projection: Record<string, unknown> = {};
  if (blendedBat) {
    projection.batting = blendedBat;
  } else if (agg.bat) {
    const stat = agg.bat.stat;
    const ab = Number(stat.atBats ?? 0);
    const bb = Number(stat.baseOnBalls ?? 0);
    const pa =
      Number(stat.plateAppearances ?? 0) > 0
        ? Number(stat.plateAppearances)
        : ab + bb;
    const obpStr = String(stat.obp ?? ".000");
    const obpNum = parseFloat(obpStr);
    projection.batting = {
      avg: String(stat.avg ?? ".000"),
      hr: Number(stat.homeRuns ?? 0),
      rbi: Number(stat.rbi ?? 0),
      runs: Number(stat.runs ?? 0),
      sb: Number(stat.stolenBases ?? 0),
      atBats: ab,
      obp: Number.isFinite(obpNum) ? obpStr : ".000",
      plateAppearances: Math.max(0, Math.round(pa)),
    };
  }
  if (blendedPit) {
    projection.pitching = {
      era: blendedPit.era,
      whip: blendedPit.whip,
      wins: blendedPit.wins,
      saves: blendedPit.saves,
      strikeouts: blendedPit.strikeouts,
      innings: blendedPit.innings,
    };
  } else if (agg.pit) {
    const stat = agg.pit.stat;
    projection.pitching = {
      era: String(stat.era ?? "0.00"),
      whip: String(stat.whip ?? "0.00"),
      wins: Number(stat.wins ?? 0),
      saves: Number(stat.saves ?? 0),
      strikeouts: Number(stat.strikeOuts ?? 0),
      innings: String(stat.inningsPitched ?? "0"),
    };
  }

  const doc: PlayerSyncDoc = {
    mlbId,
    catalogKind: "mlb",
    name: agg.bat?.player.fullName ?? agg.pit?.player.fullName ?? bio?.fullName ?? "Unknown",
    team,
    position,
    age: calcAge(bio?.birthDate),
    depthChartPosition: deriveDepthChartPosition(agg),
    value,
    catalog_tier: assignTier(value),
    stats,
    projection,
    outlook: "",
    catalogMeta: {
      stats_season: lastSeason,
      projection_blend_seasons: [lastSeason, y2, y3],
    },
  };
  if (positions.length > 0) {
    doc.positions = positions;
  }
  return doc;
}

function deriveDepthChartPosition(agg: SplitAgg): number | undefined {
  const asNum = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };
  const batStat = agg.bat?.stat ?? {};
  const pitStat = agg.pit?.stat ?? {};
  const pa = asNum((batStat as Record<string, unknown>).plateAppearances);
  const ab = asNum((batStat as Record<string, unknown>).atBats);
  const hitterVolume = pa ?? ab ?? 0;

  const gs = asNum((pitStat as Record<string, unknown>).gamesStarted);
  const sv = asNum((pitStat as Record<string, unknown>).saves);
  const ip = asNum((pitStat as Record<string, unknown>).inningsPitched);

  const hitterDepth =
    hitterVolume >= 420 ? 1 : hitterVolume >= 180 ? 2 : hitterVolume > 0 ? 3 : undefined;
  const pitcherDepth =
    (gs ?? 0) >= 20 || (ip ?? 0) >= 120
      ? 1
      : (gs ?? 0) >= 8 || (sv ?? 0) >= 15 || (ip ?? 0) >= 45
        ? 2
        : (gs ?? 0) > 0 || (sv ?? 0) > 0 || (ip ?? 0) > 0
          ? 3
          : undefined;

  if (hitterDepth == null) return pitcherDepth;
  if (pitcherDepth == null) return hitterDepth;
  return Math.min(hitterDepth, pitcherDepth);
}

interface MlbStatSplit {
  player: { id: number; fullName: string };
  team?: { id?: number; abbreviation?: string };
  position?: { abbreviation: string };
  stat: Record<string, string | number>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

async function fetchSeasonSplitsForYear(season: number): Promise<{
  batSplits: MlbStatSplit[];
  pitSplits: MlbStatSplit[];
}> {
  const [batJson, pitJson] = await Promise.all([
    fetchJson<{ stats: { splits: MlbStatSplit[] }[] }>(
      `${MLB_API}/stats?stats=season&group=hitting&season=${season}&playerPool=ALL&limit=400&sportId=1`
    ),
    fetchJson<{ stats: { splits: MlbStatSplit[] }[] }>(
      `${MLB_API}/stats?stats=season&group=pitching&season=${season}&playerPool=ALL&limit=300&sportId=1`
    ),
  ]);
  const batSplits = batJson.stats?.[0]?.splits ?? [];
  const pitSplits = pitJson.stats?.[0]?.splits ?? [];
  return { batSplits, pitSplits };
}

function indexBattingByPlayer(
  splits: MlbStatSplit[]
): Map<number, Record<string, string | number>> {
  const m = new Map<number, Record<string, string | number>>();
  for (const s of splits) {
    m.set(s.player.id, s.stat as Record<string, string | number>);
  }
  return m;
}

function indexPitchingByPlayer(
  splits: MlbStatSplit[]
): Map<number, Record<string, string | number>> {
  const m = new Map<number, Record<string, string | number>>();
  for (const s of splits) {
    m.set(s.player.id, s.stat as Record<string, string | number>);
  }
  return m;
}

async function fetchTeamAbbrevMap(): Promise<Map<number, string>> {
  const teamsJson = await fetchJson<{ teams: { id: number; abbreviation: string }[] }>(
    `${MLB_API}/teams?sportId=1&season=${LAST_COMPLETED_SEASON}`
  );
  const teamIdToAbbr = new Map<number, string>();
  for (const t of teamsJson.teams ?? []) {
    teamIdToAbbr.set(t.id, t.abbreviation);
  }
  return teamIdToAbbr;
}

async function fetchBioMap(playerIds: number[]): Promise<Map<number, MlbPlayer>> {
  const bioMap = new Map<number, MlbPlayer>();
  if (playerIds.length === 0) return bioMap;
  try {
    const bioJson = await fetchJson<{ people: MlbPlayer[] }>(
      `${MLB_API}/people?personIds=${playerIds.join(",")}&hydrate=currentTeam`
    );
    for (const p of bioJson.people ?? []) bioMap.set(p.id, p);
  } catch (err) {
    console.warn("[MLB API] Bio fetch failed (non-fatal):", (err as Error).message);
  }
  return bioMap;
}

function aggregatePositiveSplits(
  batSplits: MlbStatSplit[],
  pitSplits: MlbStatSplit[]
): Map<number, SplitAgg> {
  const aggMap = new Map<number, SplitAgg>();
  for (const s of batSplits) {
    if (calcBatterValue(s.stat) <= 0) continue;
    const row = aggMap.get(s.player.id) ?? {};
    row.bat = s;
    aggMap.set(s.player.id, row);
  }
  for (const s of pitSplits) {
    if (calcPitcherValue(s.stat) <= 0) continue;
    const row = aggMap.get(s.player.id) ?? {};
    row.pit = s;
    aggMap.set(s.player.id, row);
  }
  return aggMap;
}

function assignCatalogRankByValue(players: PlayerSyncDoc[]): PlayerSyncDoc[] {
  const sorted = [...players].sort((a, b) => b.value - a.value);
  sorted.forEach((p, i) => {
    p.catalog_rank = i + 1;
  });
  return sorted;
}

function docToIdentityRow(doc: Record<string, unknown>): CatalogIdentityRow {
  return {
    _id: String(doc._id),
    mlbId: doc.mlbId as number | null | undefined,
    name: String(doc.name ?? ""),
    team: String(doc.team ?? ""),
    position: String(doc.position ?? ""),
    positions: Array.isArray(doc.positions) ? (doc.positions as string[]) : undefined,
    catalog_rank:
      typeof doc.catalog_rank === "number"
        ? doc.catalog_rank
        : Number(doc.catalog_rank ?? doc.adp) || 0,
    catalog_tier:
      typeof doc.catalog_tier === "number"
        ? doc.catalog_tier
        : Number(doc.catalog_tier ?? doc.tier) || 0,
    value: typeof doc.value === "number" ? doc.value : Number(doc.value) || 0,
    projection: doc.projection,
  };
}

async function ensurePartialUniqueMlbIndex(): Promise<void> {
  try {
    await Player.collection.createIndex(
      { mlbId: 1 },
      {
        unique: true,
        name: "mlbId_1_partial_unique",
        partialFilterExpression: { mlbId: { $type: "number", $gt: 0 } },
      }
    );
    console.log("[MongoDB] Ensured partial unique index on mlbId");
  } catch (e) {
    console.warn(
      "[MongoDB] Could not ensure partial unique index on mlbId (duplicate mlbIds or permissions?):",
      (e as Error).message
    );
  }
}

async function fetchMlbPlayerDocs(): Promise<PlayerSyncDoc[]> {
  const last = LAST_COMPLETED_SEASON;
  const seasons = [last, last - 1, last - 2] as const;
  console.log(
    `[MongoDB] Syncing stats ${last}, projection blend ${seasons.join("/")}`
  );

  const perYear = await Promise.all(seasons.map((se) => fetchSeasonSplitsForYear(se)));
  const yearBat = new Map<number, Map<number, Record<string, string | number>>>();
  const yearPit = new Map<number, Map<number, Record<string, string | number>>>();
  for (let i = 0; i < seasons.length; i++) {
    const se = seasons[i]!;
    yearBat.set(se, indexBattingByPlayer(perYear[i]!.batSplits));
    yearPit.set(se, indexPitchingByPlayer(perYear[i]!.pitSplits));
  }
  const batSplits = perYear[0]!.batSplits;
  const pitSplits = perYear[0]!.pitSplits;
  console.log(
    `[MLB API] ${batSplits.length} batting / ${pitSplits.length} pitching splits (anchor year ${last})`
  );

  const teamIdToAbbr = await fetchTeamAbbrevMap();
  console.log(`[MLB API] Loaded ${teamIdToAbbr.size} team abbreviations`);

  const aggMap = aggregatePositiveSplits(batSplits, pitSplits);

  const allAggIds = [...aggMap.keys()];
  const bioMap = new Map<number, MlbPlayer>();
  const BIO_CHUNK = 200;
  for (let i = 0; i < allAggIds.length; i += BIO_CHUNK) {
    const slice = allAggIds.slice(i, i + BIO_CHUNK);
    const part = await fetchBioMap(slice);
    for (const [k, v] of part) bioMap.set(k, v);
  }
  console.log(`[MLB API] Fetched bio for ${bioMap.size} / ${allAggIds.length} aggregated players`);

  const playerMap = new Map<number, PlayerSyncDoc>();
  const rejectedProjectionQuarantine: { mlbId: number; reason: string }[] = [];
  for (const [mlbId, agg] of aggMap) {
    const bio = bioMap.get(mlbId);
    const doc = buildPlayerDocFromAgg(
      mlbId,
      agg,
      bio,
      teamIdToAbbr,
      yearBat,
      yearPit,
      last
    );
    if (!doc) continue;
    if (typeof mlbId !== "number" || mlbId <= 0) {
      rejectedProjectionQuarantine.push({ mlbId, reason: "invalid_mlb_id_key" });
      continue;
    }
    playerMap.set(mlbId, doc);
  }

  if (rejectedProjectionQuarantine.length > 0) {
    const qPath = path.join(ROOT, "tmp", "sync-projection-quarantine.json");
    mkdirSync(path.dirname(qPath), { recursive: true });
    writeFileSync(qPath, JSON.stringify(rejectedProjectionQuarantine, null, 2));
    console.warn(`[Sync] Wrote projection quarantine ${qPath} (${rejectedProjectionQuarantine.length})`);
  }

  return assignCatalogRankByValue([...playerMap.values()]);
}

async function runRebuildCatalog(cli: SyncCli): Promise<{
  before: Record<string, number>;
  after: Record<string, number>;
}> {
  const raw = await Player.find({})
    .select(`${PLAYER_CATALOG_LEAN_SELECT} catalogMeta`)
    .lean();
  const docs = raw as Record<string, unknown>[];

  const beforeCounts = countCatalogClasses(docs);

  const dupGroups = findDuplicateMlbIdGroups(docs.map(docToIdentityRow));
  const invalidDeletes: mongoose.Types.ObjectId[] = [];
  const dupDeletes: mongoose.Types.ObjectId[] = [];

  for (const [, arr] of dupGroups) {
    const sorted = [...arr].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const keeper = sorted[0]!;
    for (let i = 1; i < sorted.length; i++) {
      dupDeletes.push(new mongoose.Types.ObjectId(sorted[i]!._id));
    }
    console.log(
      `[Rebuild] duplicate mlbId ${keeper.mlbId}: keep ${keeper._id}, remove ${sorted.length - 1} extras`
    );
  }

  for (const d of docs) {
    const cls = classifyCatalogDoc(d);
    if (cls === "invalid_catalog_row") {
      invalidDeletes.push(new mongoose.Types.ObjectId(String(d._id)));
    }
  }

  const rebuildReport = {
    generatedAt: new Date().toISOString(),
    dryRun: cli.dryRun,
    before_catalog_class_counts: beforeCounts,
    duplicate_mlbId_groups: dupGroups.size,
    mongo_ids_to_delete_duplicate: dupDeletes.map((id) => id.toHexString()),
    mongo_ids_to_delete_invalid: invalidDeletes.map((id) => id.toHexString()),
    invalid_rows_sample: docs
      .filter((d) => classifyCatalogDoc(d) === "invalid_catalog_row")
      .slice(0, 40)
      .map((d) => ({
        _id: String(d._id),
        name: d.name,
        team: d.team,
        mlbId: d.mlbId ?? null,
        catalogKind: d.catalogKind ?? null,
      })),
  };

  const reportPath = path.join(ROOT, "tmp", "rebuild-catalog-report.json");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(rebuildReport, null, 2));
  console.log(`[Rebuild] Wrote ${reportPath}`);

  if (!cli.dryRun && !cli.confirmDestructive) {
    console.error(
      "[Rebuild] Refusing destructive rebuild without --confirm-destructive (see tmp/rebuild-catalog-report.json)"
    );
    process.exit(2);
  }

  if (!cli.dryRun && cli.confirmDestructive) {
    const archive = mongoose.connection.collection("players_catalog_archive");
    const toArchive = [...dupDeletes, ...invalidDeletes];
    if (cli.archiveInvalid && toArchive.length > 0) {
      const full = await Player.find({ _id: { $in: toArchive } }).lean();
      const stamped = full.map((doc) => ({
        ...doc,
        archivedAt: new Date(),
        archiveReason: "rebuild_catalog_dedupe_or_invalid",
      }));
      if (stamped.length > 0) {
        await archive.insertMany(stamped as Record<string, unknown>[]);
      }
      console.log(`[Rebuild] Archived ${stamped.length} docs to players_catalog_archive`);
    }
    if (dupDeletes.length > 0) {
      const r = await Player.deleteMany({ _id: { $in: dupDeletes } });
      console.log(`[Rebuild] Deleted ${r.deletedCount} duplicate mlbId rows`);
    }
    if (invalidDeletes.length > 0) {
      const r = await Player.deleteMany({ _id: { $in: invalidDeletes } });
      console.log(`[Rebuild] Deleted ${r.deletedCount} invalid non-custom rows`);
    }
  }

  let afterCounts = beforeCounts;
  if (cli.dryRun) {
    afterCounts = beforeCounts;
  } else {
    const rawAfter = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean();
    afterCounts = countCatalogClasses(rawAfter as Record<string, unknown>[]);
  }

  return { before: beforeCounts, after: afterCounts };
}

function countCatalogClasses(docs: Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {
    canonical_mlb_player: 0,
    custom_player: 0,
    invalid_catalog_row: 0,
  };
  for (const d of docs) {
    const c = classifyCatalogDoc(d);
    out[c]++;
  }
  return out;
}

async function runPostSyncGates(cli: SyncCli): Promise<void> {
  const rawDocs = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean();
  const allRows = (rawDocs as Record<string, unknown>[]).map(docToIdentityRow);

  const valuationPool = await loadMongoCatalogForEngine(undefined, {
    skipMlbHydration: process.env.AMETHYST_SKIP_MLB_TEAM_HYDRATE === "1",
  });

  const gateResult = runSyncQualityGates(allRows, valuationPool, { topTierProjectionCutoff: 3 });
  gateResult.warnings.push(...sameNameDistinctMlbIdWarning(allRows));
  const projIssues = collectProjectionSanityIssues(valuationPool, getPlayerId);
  for (const issue of projIssues) {
    gateResult.warnings.push(
      `projection sanity [${issue.reason}] ${issue.name} (${issue.player_id})`
    );
  }

  const sanityPath = path.join(ROOT, "tmp", "sync-projection-sanity.json");
  mkdirSync(path.dirname(sanityPath), { recursive: true });
  writeFileSync(sanityPath, JSON.stringify(projIssues, null, 2));

  const gatePath = path.join(ROOT, "tmp", "sync-quality-gates.json");
  writeFileSync(gatePath, JSON.stringify(gateResult, null, 2));

  console.log(
    JSON.stringify(
      {
        sync_quality_gates: {
          errors: gateResult.errors.length,
          warnings: gateResult.warnings.length,
        },
        wrote: gatePath,
      },
      null,
      2
    )
  );

  if (gateResult.errors.length > 0) {
    console.error("[Sync][gates] ERRORS:\n", gateResult.errors.join("\n"));
  }
  if (gateResult.warnings.length > 0) {
    console.warn("[Sync][gates] WARNINGS:\n", gateResult.warnings.slice(0, 40).join("\n"));
    if (gateResult.warnings.length > 40) {
      console.warn(`... and ${gateResult.warnings.length - 40} more`);
    }
  }

  if (cli.failOnGate && gateResult.errors.length > 0) {
    throw new Error(`Sync quality gates failed (${gateResult.errors.length} errors)`);
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  await mongoose.connect(MONGO_URI as string);
  console.log("[MongoDB] Connected");

  try {
    await ensurePartialUniqueMlbIndex();

    let rebuildSummary: { before: Record<string, number>; after: Record<string, number> } | null =
      null;
    if (cli.rebuildCatalog) {
      rebuildSummary = await runRebuildCatalog(cli);
      console.log(
        JSON.stringify(
          {
            rebuild_catalog_class_counts: {
              before: rebuildSummary.before,
              after: rebuildSummary.after,
            },
          },
          null,
          2
        )
      );
    }

    if (!cli.skipSync) {
      const players = await fetchMlbPlayerDocs();

      const existing = await Player.find({ mlbId: { $gt: 0 } })
        .select("mlbId")
        .lean();
      const existingIds = new Set(
        existing.map((e) => e.mlbId as number).filter((n) => typeof n === "number")
      );

      let wouldInsert = 0;
      let wouldUpdate = 0;
      for (const p of players) {
        if (existingIds.has(p.mlbId)) wouldUpdate++;
        else wouldInsert++;
      }

      const ops = players.map((p) => ({
        updateOne: {
          filter: { mlbId: p.mlbId },
          update: { $set: p },
          upsert: true,
        },
      }));

      if (cli.dryRun) {
        console.log(
          JSON.stringify(
            {
              dry_run: true,
              would_upsert_total: players.length,
              would_insert_approx: wouldInsert,
              would_update_approx: wouldUpdate,
              projection_resolution_failures: 0,
              note: "Approximate insert vs update based on existing mlbIds in Mongo.",
            },
            null,
            2
          )
        );
      } else {
        const result = await Player.bulkWrite(ops);
        console.log(
          `[Sync] Done — ${result.upsertedCount} inserted, ${result.modifiedCount} modified, ${players.length} upserts`
        );
      }
    }

    await runPostSyncGates(cli);
  } finally {
    await mongoose.disconnect();
    console.log("[MongoDB] Disconnected");
  }
}

main().catch((err) => {
  console.error("[Sync] Error:", err);
  process.exit(1);
});
