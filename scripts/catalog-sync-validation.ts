/**
 * Catalog sync validation snapshots (Mongo + valuation metrics).
 * Usage:
 *   pnpm exec ts-node --project tsconfig.scripts.json scripts/catalog-sync-validation.ts before
 *   pnpm exec ts-node --project tsconfig.scripts.json scripts/catalog-sync-validation.ts after
 */
import "dotenv/config";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import Player from "../src/models/Player";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { runRosterCatalogUniverseBuild } from "../src/lib/mlbCatalogUniverse/runRosterCatalogUniverseBuild";
import type { ExistingPlayerMarketFields } from "../src/lib/mlbCatalogUniverse/runRosterCatalogUniverseBuild";

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, "tmp");
const MLB_API = "https://statsapi.mlb.com/api/v1";
const LAST_COMPLETED_SEASON = new Date().getFullYear() - 1;
const DEFAULT_ROSTER_TYPES = ["40Man", "active", "fullSeason"] as const;

const WATCH_IDS = [670541, 547180, 701762, 519242, 606466];

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

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

async function snapshot(label: "before" | "after"): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");
  mkdirSync(TMP, { recursive: true });

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let pool;
  try {
    pool = await loadMongoCatalogForEngine(undefined);
    const mongoWatch = await Player.find({ mlbId: { $in: WATCH_IDS } })
      .select("mlbId name team position value catalog_rank catalog_tier market_adp market_adp_source")
      .lean();

    const input = buildDraftroomStandardValuationInput({
      user_team_id: "team_1",
      deterministic: true,
      seed: 42,
    });
    const wf = executeValuationWorkflow(pool, input, {}, { debugSignals: false });
    if (!wf.ok) throw new Error(JSON.stringify(wf.issues));

    const v = wf.response.valuations;
    const watchV = v.filter((r) => WATCH_IDS.includes(Number(r.player_id)));

    const sortedAuction = [...v].sort((a, b) => b.auction_value - a.auction_value);
    const top25Auction = sortedAuction.slice(0, 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      auction_value: r.auction_value,
      market_adp: r.market_adp ?? null,
      catalog_rank: r.catalog_rank,
    }));

    const withAdp = v.filter((r) => r.market_adp != null && Number.isFinite(r.market_adp));
    const top25Adp = [...withAdp]
      .sort((a, b) => (a.market_adp ?? 9999) - (b.market_adp ?? 9999))
      .slice(0, 25)
      .map((r) => ({
        player_id: r.player_id,
        name: r.name,
        market_adp: r.market_adp,
        auction_value: r.auction_value,
        catalog_rank: r.catalog_rank,
      }));

    const adp50_le_1 = withAdp
      .filter((r) => r.market_adp! <= 50 && r.auction_value <= 1.05)
      .map((r) => ({
        player_id: r.player_id,
        name: r.name,
        market_adp: r.market_adp,
        auction_value: r.auction_value,
        catalog_rank: r.catalog_rank,
      }));

    const adp50_rank300 = withAdp
      .filter((r) => r.market_adp! <= 50 && r.catalog_rank > 300)
      .map((r) => ({
        player_id: r.player_id,
        name: r.name,
        market_adp: r.market_adp,
        auction_value: r.auction_value,
        catalog_rank: r.catalog_rank,
      }));

    const body = {
      label,
      generatedAt: new Date().toISOString(),
      mongo_watch: mongoWatch,
      valuation_watch: watchV.map((r) => ({
        player_id: r.player_id,
        name: r.name,
        value_mongo_sync_field:
          mongoWatch.find((m) => String(m.mlbId) === r.player_id)?.value ?? null,
        catalog_rank: r.catalog_rank,
        market_adp: r.market_adp,
        baseline_value: r.baseline_value,
        auction_value: r.auction_value,
        recommended_bid: r.recommended_bid ?? null,
        team_adjusted_value: r.team_adjusted_value ?? null,
      })),
      top25_auction_value: top25Auction,
      top25_market_adp_asc: top25Adp,
      market_adp_lte_50_and_auction_lte_1_05: adp50_le_1,
      market_adp_lte_50_and_catalog_rank_gt_300: adp50_rank300,
      pool_size: pool.length,
      valuation_row_count: v.length,
    };

    const outPath = path.join(TMP, `catalog-validation-${label}.json`);
    writeFileSync(outPath, JSON.stringify(body, null, 2), "utf8");
    console.log(`Wrote ${outPath}`);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

async function dryRunBuildSpotcheck(): Promise<void> {
  mkdirSync(TMP, { recursive: true });
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let nfbcFromMongo: Set<number>;
  let existingMarket: Map<number, ExistingPlayerMarketFields>;
  try {
    nfbcFromMongo = await loadNfbcMlbIdSetFromMongo();
    existingMarket = await loadExistingMarketFieldsByMlbId();
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const { players } = await runRosterCatalogUniverseBuild({
    mlbApiBase: MLB_API,
    lastCompletedSeason: LAST_COMPLETED_SEASON,
    fetchJson,
    statsPageSize: 500,
    rosterTypes: [...DEFAULT_ROSTER_TYPES],
    nfbcPreviewJson: undefined,
    nfbcMlbIdsFromMongo: nfbcFromMongo,
    existingMarketByMlbId: existingMarket,
  });

  const byId = new Map(players.map((p) => [p.mlbId, p]));
  const spot = WATCH_IDS.map((id) => {
    const p = byId.get(id);
    if (!p)
      return {
        mlbId: id,
        error: "not_in_build_output",
      };
    return {
      mlbId: id,
      name: p.name,
      value: p.value,
      catalog_rank: p.catalog_rank,
      catalog_tier: p.catalog_tier,
      catalogValuationTier: p.catalogValuationTier,
      position: p.position,
      market_adp: p.market_adp ?? null,
    };
  });

  const adpLe50ValLe2 = players
    .filter(
      (p) =>
        typeof p.market_adp === "number" &&
        p.market_adp <= 50 &&
        typeof p.value === "number" &&
        p.value <= 2
    )
    .sort((a, b) => (a.market_adp ?? 999) - (b.market_adp ?? 999))
    .slice(0, 80)
    .map((p) => ({
      mlbId: p.mlbId,
      name: p.name,
      value: p.value,
      catalog_rank: p.catalog_rank,
      market_adp: p.market_adp,
    }));

  const adpLe50RankGt300 = players
    .filter(
      (p) =>
        typeof p.market_adp === "number" &&
        p.market_adp <= 50 &&
        typeof p.catalog_rank === "number" &&
        p.catalog_rank > 300
    )
    .sort((a, b) => (a.market_adp ?? 999) - (b.market_adp ?? 999))
    .slice(0, 80)
    .map((p) => ({
      mlbId: p.mlbId,
      name: p.name,
      value: p.value,
      catalog_rank: p.catalog_rank,
      market_adp: p.market_adp,
    }));

  const outPath = path.join(TMP, "dry-run-universe-value-spotcheck.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        anchor_season_note: LAST_COMPLETED_SEASON,
        spotcheck_watch_ids: spot,
        market_adp_lte_50_and_value_lte_2: adpLe50ValLe2,
        market_adp_lte_50_and_catalog_rank_gt_300: adpLe50RankGt300,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Wrote ${outPath}`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === "before" || mode === "after") {
    await snapshot(mode);
    return;
  }
  if (mode === "dry-run-build") {
    await dryRunBuildSpotcheck();
    return;
  }
  console.error("Usage: ... before | after | dry-run-build");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
