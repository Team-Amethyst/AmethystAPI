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
 *
 * Roster + NFBC catalog universe (v1, dry-run by default for writes):
 *   pnpm sync-players -- --roster-universe-v1 --dry-run
 *   pnpm sync-players -- --roster-universe-v1 --universe-nfbc-preview tmp/nfbc-data-mongo-preview.json --dry-run
 *   pnpm sync-players -- --roster-universe-v1 --confirm-universe-write   # writes Mongo (requires non-dry-run)
 *
 * Roster-universe stat maps mirror legacy capped sync for anchor-capped MLB IDs (paginated fill only
 * where appropriate); see `runRosterCatalogUniverseBuild` in `src/lib/mlbCatalogUniverse/`.
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { MlbPlayer, PlayerSyncDoc } from "../src/lib/mlbPlayerSyncFromSplits";
import { fetchCappedSeasonSplitsLikeSync } from "../src/lib/mlbSyncCappedSeasonSplits";
import {
  aggregatePositiveSplits,
  assignCatalogRankByValue,
  buildPlayerDocFromAgg,
  indexBattingByPlayer,
  indexPitchingByPlayer,
} from "../src/lib/mlbPlayerSyncFromSplits";
import type { ExistingPlayerMarketFields } from "../src/lib/mlbCatalogUniverse/runRosterCatalogUniverseBuild";
import { runRosterCatalogUniverseBuild } from "../src/lib/mlbCatalogUniverse/runRosterCatalogUniverseBuild";
import type { RosterTypeParam } from "../src/lib/mlbCatalogUniverse/types";
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

type SyncCli = {
  dryRun: boolean;
  rebuildCatalog: boolean;
  confirmDestructive: boolean;
  skipSync: boolean;
  failOnGate: boolean;
  archiveInvalid: boolean;
  rosterUniverseV1: boolean;
  confirmUniverseWrite: boolean;
  universeNfbcPreviewPath?: string;
};

function parseArgs(argv: string[]): SyncCli {
  const a = new Set(argv.filter((x) => x !== "--"));
  let universeNfbcPreviewPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--universe-nfbc-preview" && argv[i + 1]) {
      const raw = argv[i + 1]!;
      universeNfbcPreviewPath = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
      i++;
    }
  }
  return {
    dryRun: a.has("--dry-run") || a.has("--dryRun"),
    rebuildCatalog: a.has("--rebuild-catalog") || a.has("--rebuildCatalog"),
    confirmDestructive: a.has("--confirm-destructive") || a.has("--confirmDestructive"),
    skipSync: a.has("--skip-sync") || a.has("--skipSync"),
    failOnGate: !a.has("--no-fail-gates"),
    archiveInvalid: a.has("--archive-invalid"),
    rosterUniverseV1: a.has("--roster-universe-v1") || a.has("--rosterUniverseV1"),
    confirmUniverseWrite: a.has("--confirm-universe-write") || a.has("--confirmUniverseWrite"),
    universeNfbcPreviewPath,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
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

  const perYear = await Promise.all(
    seasons.map((se) => fetchCappedSeasonSplitsLikeSync({ mlbApiBase: MLB_API, season: se, fetchJson }))
  );
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
    doc.catalogValuationTier = "valuation_eligible";
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

const DEFAULT_ROSTER_TYPES: RosterTypeParam[] = ["40Man", "active", "fullSeason"];

async function loadNfbcMlbIdSetFromMongo(): Promise<Set<number>> {
  const rows = await Player.find({
    mlbId: { $gt: 0 },
    market_adp: { $exists: true, $ne: null },
  })
    .select({ mlbId: 1 })
    .lean();
  return new Set(
    rows
      .map((r) => r.mlbId as number)
      .filter((n): n is number => typeof n === "number" && n > 0)
  );
}

async function loadExistingMarketFieldsByMlbId(): Promise<Map<number, ExistingPlayerMarketFields>> {
  const rows = await Player.find({
    mlbId: { $gt: 0 },
    $or: [
      { market_adp: { $exists: true, $ne: null } },
      { market_adp_source: { $exists: true, $nin: [null, ""] } },
    ],
  })
    .select({
      mlbId: 1,
      market_adp: 1,
      market_adp_source: 1,
      market_adp_updated_at: 1,
      market_adp_min: 1,
      market_adp_max: 1,
      market_pick_count: 1,
    })
    .lean();
  const m = new Map<number, ExistingPlayerMarketFields>();
  for (const r of rows) {
    const id = r.mlbId as number;
    if (typeof id !== "number" || id <= 0) continue;
    m.set(id, {
      market_adp: r.market_adp as number | undefined,
      market_adp_source: r.market_adp_source as string | undefined,
      market_adp_updated_at: r.market_adp_updated_at as string | undefined,
      market_adp_min: r.market_adp_min as number | undefined,
      market_adp_max: r.market_adp_max as number | undefined,
      market_pick_count: r.market_pick_count as number | undefined,
    });
  }
  return m;
}

async function runRosterUniverseSync(cli: SyncCli): Promise<void> {
  let preview: unknown | undefined;
  if (cli.universeNfbcPreviewPath) {
    preview = JSON.parse(readFileSync(cli.universeNfbcPreviewPath, "utf8"));
  }
  const nfbcFromMongo = await loadNfbcMlbIdSetFromMongo();
  const existingMarket = await loadExistingMarketFieldsByMlbId();
  const { report, players } = await runRosterCatalogUniverseBuild({
    mlbApiBase: MLB_API,
    lastCompletedSeason: LAST_COMPLETED_SEASON,
    fetchJson,
    statsPageSize: 500,
    rosterTypes: DEFAULT_ROSTER_TYPES,
    nfbcPreviewJson: preview,
    nfbcMlbIdsFromMongo: nfbcFromMongo,
    existingMarketByMlbId: existingMarket,
  });
  const reportPath = path.join(ROOT, "tmp/catalog-universe-report.json");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        catalog_universe_v1_report: report,
        wrote_report: reportPath,
      },
      null,
      2
    )
  );

  const shouldWrite = !cli.dryRun && cli.confirmUniverseWrite;
  if (!shouldWrite) {
    console.log(
      "[Sync] Roster universe v1: skipping Mongo writes (use --confirm-universe-write without --dry-run to upsert)."
    );
    return;
  }

  const ops = players.map((p) => ({
    updateOne: {
      filter: { mlbId: p.mlbId },
      update: { $set: p as Record<string, unknown> },
      upsert: true,
    },
  }));
  const result = await Player.bulkWrite(ops);
  console.log(
    `[Sync] Roster universe upsert — ${result.upsertedCount} inserted, ${result.modifiedCount} modified, ${players.length} total`
  );
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

    if (cli.rosterUniverseV1) {
      await runRosterUniverseSync(cli);
    } else if (!cli.skipSync) {
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
