/**
 * Dry-run market ADP ingestion: load vendor CSV + catalog (Mongo or JSON), match, emit preview JSON.
 * Never writes Mongo.
 *
 * Usage (fixture profile is default; CSV defaults to sample fixture when omitted):
 *   pnpm market-adp-preview
 *   pnpm market-adp-preview -- --catalog-json path/to/catalog.json --out tmp/preview.json
 *
 * NFBC local CSV (debug / manual export):
 *   pnpm market-adp-preview -- --source nfbc --csv tmp/nfbc.csv
 *
 * NFBC remote CSV (operator URL — no hardcoded private URLs; use env or CLI):
 *   pnpm market-adp-preview -- --source nfbc --url "$NFBC_ADP_URL"
 *   NFBC_ADP_URL=https://example.com/path.csv pnpm market-adp-preview -- --source nfbc --out tmp/preview.json
 *
 * Optional auth (env only, never commit):
 *   NFBC_ADP_BEARER_TOKEN=…
 *   NFBC_ADP_AUTHORIZATION="Bearer …"   (full header value)
 *
 * Optional timeout:
 *   --fetch-timeout-ms 45000
 *   NFBC_ADP_FETCH_TIMEOUT_MS=45000
 *
 * Mongo catalog (optional):
 *   MONGO_URI=... pnpm market-adp-preview -- --mongo --source nfbc --csv path/to.csv
 *
 * NFBC public `adp.data.php` (plain text, automated dry-run):
 *   pnpm market-adp-preview -- --source nfbc-data --out tmp/nfbc-data-preview.json
 *   pnpm market-adp-preview -- --source nfbc-data --url https://nfc.shgn.com/adp.data.php
 *   NFBC_ADP_URL=… pnpm market-adp-preview -- --source nfbc-data --out tmp/preview.json
 *
 * Feature flag (informational): AMETHYST_MARKET_ADP_ADAPTER matches adapter id
 * (csv_fixture | nfbc_csv | nfbc_remote_csv | nfbc_data_php).
 */
import dotenv from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import {
  createCsvFixtureAdapter,
  createNfbcCsvAdapter,
  createNfbcDataPhpAdapter,
  createNfbcRemoteCsvAdapter,
  dryRunMatchMarketAdp,
  type DryRunMatch,
  type MarketAdpAdapter,
  redactMarketAdpSourceUrl,
  resolveNfbcAuthorizationFromEnv,
  resolveNfbcDataPhpUrl,
  resolveNfbcFetchTimeoutMsFromEnv,
} from "../src/lib/marketAdp";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import type { LeanPlayer } from "../src/types/core";

dotenv.config();

const ROOT = path.resolve(__dirname, "..");

type MarketAdpSourceCli = "csv_fixture" | "nfbc" | "nfbc_data";

type ParsedArgs = {
  source: MarketAdpSourceCli;
  /** Local CSV path (csv_fixture always; nfbc when not using remote URL). */
  csvPath: string;
  /** When set, fetch NFBC-shaped CSV from this https URL instead of reading csvPath. */
  nfbcRemoteUrl?: string;
  /** Resolved in createAdapter via `resolveNfbcDataPhpUrl` (CLI `--url` or env or default data.php). */
  nfbcDataPhpUrl?: string;
  catalogJson?: string;
  mongo: boolean;
  out: string;
  fetchTimeoutMs?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const a = argv.slice(2);
  let source: MarketAdpSourceCli = "csv_fixture";
  let csv = "";
  let csvExplicit = false;
  let url = "";
  let urlExplicit = false;
  let catalogJson: string | undefined;
  let mongo = false;
  let out = path.join(ROOT, "tmp/market-adp-ingest-preview.json");
  let fetchTimeoutMs: number | undefined;

  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--source" && a[i + 1]) {
      const s = a[++i]!.trim().toLowerCase();
      if (s === "nfbc" || s === "nfc") source = "nfbc";
      else if (s === "nfbc-data" || s === "nfbc_data" || s === "nfbcdata") source = "nfbc_data";
      else if (s === "csv_fixture" || s === "fixture" || s === "csv") source = "csv_fixture";
      else
        throw new Error(
          `Unknown --source "${s}" (use nfbc, nfbc-data, or csv_fixture)`
        );
    } else if (a[i] === "--csv" && a[i + 1]) {
      csv = a[++i]!;
      csvExplicit = true;
    } else if ((a[i] === "--url" || a[i] === "--source-url") && a[i + 1]) {
      url = a[++i]!;
      urlExplicit = true;
    } else if (a[i] === "--fetch-timeout-ms" && a[i + 1]) {
      const n = Number(a[++i]!);
      if (Number.isFinite(n) && n > 0 && n <= 600_000) fetchTimeoutMs = Math.trunc(n);
    } else if (a[i] === "--catalog-json" && a[i + 1]) {
      catalogJson = a[++i]!;
    } else if (a[i] === "--mongo") {
      mongo = true;
    } else if (a[i] === "--out" && a[i + 1]) {
      out = a[++i]!;
    }
  }

  if (urlExplicit && source === "csv_fixture") {
    throw new Error("--url / --source-url require --source nfbc or nfbc-data");
  }
  if (urlExplicit && csvExplicit) {
    throw new Error("Use only one of --csv or --url/--source-url");
  }
  if (csvExplicit && source === "nfbc_data") {
    throw new Error("--csv is not valid with --source nfbc-data");
  }

  const absCsv = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

  if (source === "csv_fixture") {
    const csvPath = csvExplicit ? absCsv(csv) : path.join(ROOT, "test-fixtures/market-adp/sample-adp.csv");
    return {
      source,
      csvPath,
      catalogJson: catalogJson ? absCsv(catalogJson) : undefined,
      mongo,
      out: path.isAbsolute(out) ? out : path.join(ROOT, out),
      fetchTimeoutMs,
    };
  }

  if (source === "nfbc_data") {
    return {
      source: "nfbc_data",
      csvPath: "",
      nfbcDataPhpUrl: urlExplicit ? url.trim() : undefined,
      catalogJson: catalogJson ? absCsv(catalogJson) : undefined,
      mongo,
      out: path.isAbsolute(out) ? out : path.join(ROOT, out),
      fetchTimeoutMs,
    };
  }

  const envUrl = (process.env.NFBC_ADP_URL || process.env.AMETHYST_NFBC_ADP_URL || "").trim();

  if (urlExplicit) {
    return {
      source: "nfbc",
      csvPath: "",
      nfbcRemoteUrl: url.trim(),
      catalogJson: catalogJson ? absCsv(catalogJson) : undefined,
      mongo,
      out: path.isAbsolute(out) ? out : path.join(ROOT, out),
      fetchTimeoutMs,
    };
  }

  if (csvExplicit) {
    return {
      source: "nfbc",
      csvPath: absCsv(csv),
      catalogJson: catalogJson ? absCsv(catalogJson) : undefined,
      mongo,
      out: path.isAbsolute(out) ? out : path.join(ROOT, out),
      fetchTimeoutMs,
    };
  }

  if (envUrl) {
    return {
      source: "nfbc",
      csvPath: "",
      nfbcRemoteUrl: envUrl,
      catalogJson: catalogJson ? absCsv(catalogJson) : undefined,
      mongo,
      out: path.isAbsolute(out) ? out : path.join(ROOT, out),
      fetchTimeoutMs,
    };
  }

  throw new Error(
    "NFBC: provide --csv <path>, or --url/--source-url <https://...>, or set NFBC_ADP_URL / AMETHYST_NFBC_ADP_URL"
  );
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

function createAdapter(args: ParsedArgs): MarketAdpAdapter {
  const timeoutMs = args.fetchTimeoutMs ?? resolveNfbcFetchTimeoutMsFromEnv();
  const auth = resolveNfbcAuthorizationFromEnv();

  if (args.source === "nfbc_data") {
    const url = resolveNfbcDataPhpUrl(args.nfbcDataPhpUrl);
    return createNfbcDataPhpAdapter(url, {
      timeoutMs,
      authorization: auth,
    });
  }

  if (args.source === "nfbc" && args.nfbcRemoteUrl) {
    return createNfbcRemoteCsvAdapter(args.nfbcRemoteUrl, {
      timeoutMs,
      authorization: auth,
    });
  }
  if (args.source === "nfbc") {
    return createNfbcCsvAdapter(args.csvPath);
  }
  return createCsvFixtureAdapter(args.csvPath);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const adapter = createAdapter(args);
  const adapterEnv = process.env.AMETHYST_MARKET_ADP_ADAPTER ?? adapter.id;
  const fetchedAt = new Date().toISOString();
  const vendorRows = await adapter.fetchRows({
    sourceName: adapter.displayName,
    fetchedAt,
  });
  const catalog = await loadCatalog({
    mongo: args.mongo,
    catalogJson: args.catalogJson,
  });

  const {
    matches,
    proposed_updates,
    stats: matchStats,
    confidence_breakdown,
    catalog_audit_top_200,
    catalog_unmatched_report,
    unmatched_vendor_top_by_adp,
  } = dryRunMatchMarketAdp(catalog, vendorRows, adapter.displayName, fetchedAt);

  const resolvedDataPhpUrl =
    args.source === "nfbc_data" ? resolveNfbcDataPhpUrl(args.nfbcDataPhpUrl) : undefined;

  const vendorSummary = summarize(matches);
  const stats = {
    source_cli: args.source,
    adapter_env: adapterEnv,
    vendor_rows: vendorRows.length,
    catalog_players: catalog.length,
    ...vendorSummary,
    proposed_update_count: proposed_updates.length,
    /** Primary: catalog players successfully linked to an NFBC row. */
    matched_catalog_players: matchStats.matched_catalog_players,
    catalog_players_with_nfbc_name: matchStats.catalog_players_with_nfbc_name,
    catalog_coverage_vs_catalog_pct: matchStats.catalog_coverage_vs_catalog,
    catalog_coverage_vs_nfbc_named_pct: matchStats.catalog_coverage_vs_nfbc_named,
  };

  const outDir = path.dirname(args.out);
  mkdirSync(outDir, { recursive: true });
  const payload = {
    adapter_id: adapter.id,
    adapter_display_name: adapter.displayName,
    csv_path:
      args.source === "nfbc_data" || args.nfbcRemoteUrl ? null : args.csvPath,
    remote_csv_url_redacted: args.nfbcRemoteUrl
      ? redactMarketAdpSourceUrl(args.nfbcRemoteUrl)
      : undefined,
    data_php_url_redacted:
      args.source === "nfbc_data" && resolvedDataPhpUrl
        ? redactMarketAdpSourceUrl(resolvedDataPhpUrl)
        : undefined,
    catalog_source: args.mongo ? "mongo" : "catalog_json",
    fetched_at: fetchedAt,
    stats,
    confidence_breakdown,
    catalog_audit_top_200,
    catalog_unmatched_report,
    unmatched_vendor_top_by_adp,
    matches,
    proposed_updates,
    notes: [
      "Dry-run only: no Mongo writes.",
      "Ambiguous vendor rows must be resolved before any apply step.",
      "Remote CSV: configure NFBC_ADP_URL or pass --url; never commit credentials.",
      "nfbc-data: default URL is https://nfc.shgn.com/adp.data.php unless overridden via --url or NFBC_ADP_URL / AMETHYST_NFBC_ADP_URL.",
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
