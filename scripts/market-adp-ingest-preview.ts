/**
 * Dry-run market ADP ingestion: load vendor CSV + catalog (Mongo or JSON), match, emit preview JSON.
 * Never writes Mongo.
 *
 * Usage:
 *   pnpm exec ts-node --project tsconfig.scripts.json scripts/market-adp-ingest-preview.ts \
 *     --csv test-fixtures/market-adp/sample-adp.csv \
 *     --catalog-json test-fixtures/market-adp/catalog-sample.json \
 *     --out tmp/market-adp-ingest-preview.json
 *
 * Mongo catalog (optional):
 *   MONGO_URI=... pnpm exec ts-node ... --mongo --csv path/to.csv
 *
 * Feature flag (informational): AMETHYST_MARKET_ADP_ADAPTER=csv_fixture
 */
import dotenv from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import {
  createCsvFixtureAdapter,
  dryRunMatchMarketAdp,
  type DryRunMatch,
} from "../src/lib/marketAdp";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import type { LeanPlayer } from "../src/types/core";

dotenv.config();

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv: string[]): {
  csv: string;
  catalogJson?: string;
  mongo: boolean;
  out: string;
} {
  const a = argv.slice(2);
  let csv = "";
  let catalogJson: string | undefined;
  let mongo = false;
  let out = path.join(ROOT, "tmp/market-adp-ingest-preview.json");
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--csv" && a[i + 1]) {
      csv = a[++i]!;
    } else if (a[i] === "--catalog-json" && a[i + 1]) {
      catalogJson = a[++i]!;
    } else if (a[i] === "--mongo") {
      mongo = true;
    } else if (a[i] === "--out" && a[i + 1]) {
      out = a[++i]!;
    }
  }
  if (!csv) {
    throw new Error("Required: --csv <path-to-adp.csv>");
  }
  return {
    csv: path.isAbsolute(csv) ? csv : path.join(ROOT, csv),
    catalogJson: catalogJson
      ? path.isAbsolute(catalogJson)
        ? catalogJson
        : path.join(ROOT, catalogJson)
      : undefined,
    mongo,
    out: path.isAbsolute(out) ? out : path.join(ROOT, out),
  };
}

function summarize(matches: DryRunMatch[]): {
  matched: number;
  ambiguous: number;
  unmatched_vendor: number;
} {
  let matched = 0;
  let ambiguous = 0;
  let unmatched_vendor = 0;
  for (const m of matches) {
    if (m.kind === "matched") matched++;
    else if (m.kind === "ambiguous") ambiguous++;
    else if (m.kind === "unmatched_vendor") unmatched_vendor++;
  }
  return { matched, ambiguous, unmatched_vendor };
}

async function loadCatalog(params: {
  mongo: boolean;
  catalogJson?: string;
}): Promise<LeanPlayer[]> {
  if (params.mongo) {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI required for --mongo");
    await mongoose.connect(uri);
    try {
      process.env.AMETHYST_SKIP_MLB_TEAM_HYDRATE = "1";
      return await loadMongoCatalogForEngine(
        { warn: console.warn, info: console.info },
        { skipMlbHydration: true }
      );
    } finally {
      await mongoose.disconnect().catch(() => undefined);
    }
  }
  const jsonPath =
    params.catalogJson ?? path.join(ROOT, "test-fixtures/market-adp/catalog-sample.json");
  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as unknown[];
  return normalizeCatalogPlayers(raw, () => undefined);
}

async function main(): Promise<void> {
  const adapterEnv = process.env.AMETHYST_MARKET_ADP_ADAPTER ?? "csv_fixture";
  const args = parseArgs(process.argv);
  const adapter = createCsvFixtureAdapter(args.csv);
  const fetchedAt = new Date().toISOString();
  const vendorRows = await adapter.fetchRows({
    sourceName: adapter.displayName,
    fetchedAt,
  });
  const catalog = await loadCatalog({
    mongo: args.mongo,
    catalogJson: args.catalogJson,
  });

  const { matches, proposed_updates } = dryRunMatchMarketAdp(
    catalog,
    vendorRows,
    adapter.displayName,
    fetchedAt
  );

  const stats = {
    adapter_env: adapterEnv,
    vendor_rows: vendorRows.length,
    catalog_players: catalog.length,
    ...summarize(matches),
    proposed_update_count: proposed_updates.length,
  };

  const outDir = path.dirname(args.out);
  mkdirSync(outDir, { recursive: true });
  const payload = {
    adapter_id: adapter.id,
    adapter_display_name: adapter.displayName,
    csv_path: args.csv,
    catalog_source: args.mongo ? "mongo" : "catalog_json",
    fetched_at: fetchedAt,
    stats,
    matches,
    proposed_updates,
    notes: [
      "Dry-run only: no Mongo writes.",
      "Ambiguous vendor rows must be resolved before any apply step.",
    ],
  };
  writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${args.out}`);
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
