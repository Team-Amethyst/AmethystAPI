/**
 * Dry-run catalog universe: roster IDs ∪ NFBC preview MLB IDs via `runRosterCatalogUniverseBuild`.
 * **Never connects to Mongo.**
 *
 * Usage:
 *   pnpm catalog-universe:dry-run -- --preview tmp/nfbc-data-mongo-preview.json
 *   pnpm catalog-universe:dry-run -- --preview path/to/preview.json --out tmp/my-universe-report.json
 *
 * Generate preview (optional, needs MONGO_URI for --mongo):
 *   pnpm market-adp-preview -- --source nfbc-data --mongo --out tmp/nfbc-data-mongo-preview.json
 */
import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { runRosterCatalogUniverseBuild } from "../src/lib/mlbCatalogUniverse/runRosterCatalogUniverseBuild";
import type { RosterTypeParam } from "../src/lib/mlbCatalogUniverse/types";

dotenv.config();

const ROOT = path.resolve(__dirname, "..");
const MLB_API = "https://statsapi.mlb.com/api/v1";
const LAST_COMPLETED_SEASON = new Date().getFullYear() - 1;

const DEFAULT_ROSTER_TYPES: RosterTypeParam[] = ["40Man", "active", "fullSeason"];

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

function parseArgs(argv: string[]): { previewPath: string; outPath: string } {
  const a = argv.slice(2);
  let previewPath = path.join(ROOT, "tmp/nfbc-data-mongo-preview.json");
  let outPath = path.join(ROOT, "tmp/catalog-universe-dry-run-report.json");
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--preview" && a[i + 1]) {
      const raw = a[++i]!;
      previewPath = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
    } else if (a[i] === "--out" && a[i + 1]) {
      const raw = a[++i]!;
      outPath = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
    }
  }
  return { previewPath, outPath };
}

async function main(): Promise<void> {
  const { previewPath, outPath } = parseArgs(process.argv);
  if (!existsSync(previewPath)) {
    console.error(
      `Preview file not found: ${previewPath}\n` +
        `Create one with e.g.:\n` +
        `  pnpm market-adp-preview -- --source nfbc-data --mongo --out tmp/nfbc-data-mongo-preview.json\n` +
        `Then:\n` +
        `  pnpm catalog-universe:dry-run -- --preview tmp/nfbc-data-mongo-preview.json`
    );
    process.exit(1);
  }

  const previewJson = JSON.parse(readFileSync(previewPath, "utf8"));

  const { report } = await runRosterCatalogUniverseBuild({
    mlbApiBase: MLB_API,
    lastCompletedSeason: LAST_COMPLETED_SEASON,
    fetchJson,
    statsPageSize: 500,
    rosterTypes: DEFAULT_ROSTER_TYPES,
    nfbcPreviewJson: previewJson,
    nfbcMlbIdsFromMongo: new Set(),
    existingMarketByMlbId: new Map(),
  });

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ preview_path: previewPath, report }, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        wrote: outPath,
        candidate_count: report.candidate_count,
        roster_candidate_count: report.roster_candidate_count,
        nfbc_preview_candidate_count: report.nfbc_preview_candidate_count,
        overlap_roster_nfbc_preview_count: report.overlap_roster_nfbc_preview_count,
        valuation_eligible_count: report.valuation_eligible_count,
        market_only_count: report.market_only_count,
        roster_context_count: report.roster_context_count,
        spotlight_players: report.spotlight_players,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
