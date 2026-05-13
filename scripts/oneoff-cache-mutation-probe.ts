/**
 * One-off diagnostic — does running `executeValuationWorkflow` corrupt the
 * in-process catalog cache?
 *
 * Procedure:
 *  1. Connect to Mongo with the same env (`.env`).
 *  2. **Force cache enabled** by clearing the `VITEST=true` default in
 *     `mongoCatalogCache.isCatalogCacheDisabled()` — we set `VITEST=false`
 *     before importing the modules.
 *  3. Call `loadMongoCatalogForEngine({ skipMlbHydration: true })` once
 *     (cold) — populates cache.
 *  4. Snapshot projection / age / depthChartPosition state for a fixed
 *     set of mlbIds (Judge, Ohtani, Skubal, Skenes, Soto, Witt, Verlander,
 *     Jansen) on the **returned** rows.
 *  5. Run `executeValuationWorkflow(returned_rows, input)` with the
 *     `pre_draft.json` fixture, just like `/valuation/calculate` does.
 *  6. Call `loadMongoCatalogForEngine` AGAIN (cache hit) — capture rows.
 *  7. Re-snapshot the same fields and DIFF.
 *  8. Run the workflow once more on the cache-hit rows and report
 *     baseline distinctness on both passes (was it varied? did it stay
 *     varied?).
 *
 * If any field drops between snapshot #1 and snapshot #2, we have
 * cache-mutation corruption that survives `structuredClone`. If both
 * passes produce uniform `$10` baselines locally with the same code, the
 * bug reproduces locally and isn't App-Runner-specific.
 */
process.env.VITEST = "false";

import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import {
  loadMongoCatalogForEngine,
  invalidateCatalogCache,
} from "../src/lib/mongoCatalogPipeline";
import {
  isCatalogCacheDisabled,
  getCatalogCacheTtlMs,
} from "../src/lib/mongoCatalogCache";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { isBaselineOutputCollapsed } from "../src/lib/catalogProjectionHealth";

dotenv.config();

const TARGET_MLB_IDS = [
  592450, // Aaron Judge
  660271, // Shohei Ohtani
  669373, // Tarik Skubal
  694973, // Paul Skenes
  665742, // Juan Soto
  677951, // Bobby Witt Jr.
  434378, // Justin Verlander
  445276, // Kenley Jansen
];

type Snapshot = {
  count: number;
  with_projection: number;
  with_batting_hr: number;
  with_pitching_strikeouts: number;
  with_age: number;
  with_depth_chart_position: number;
  samples: Array<{
    mlbId: number | null;
    name: string;
    age: number | null;
    depthChartPosition: number | null;
    catalog_rank: number | null;
    catalogValuationTier: string | null;
    projection_keys: string[];
    batting_hr: number | null;
    pitching_strikeouts: number | null;
  }>;
};

function snapshotRows(label: string, rows: any[]): Snapshot {
  const samples: Snapshot["samples"] = [];
  let with_projection = 0;
  let with_batting_hr = 0;
  let with_pitching_strikeouts = 0;
  let with_age = 0;
  let with_depth_chart_position = 0;
  for (const r of rows) {
    if (r.projection && typeof r.projection === "object") with_projection++;
    if (r?.projection?.batting?.hr != null) with_batting_hr++;
    if (r?.projection?.pitching?.strikeouts != null) with_pitching_strikeouts++;
    if (typeof r.age === "number" && Number.isFinite(r.age)) with_age++;
    if (
      typeof r.depthChartPosition === "number" &&
      Number.isFinite(r.depthChartPosition)
    )
      with_depth_chart_position++;
  }
  for (const target of TARGET_MLB_IDS) {
    const row = rows.find((r) => r.mlbId === target);
    if (!row) continue;
    samples.push({
      mlbId: row.mlbId ?? null,
      name: row.name ?? "?",
      age: typeof row.age === "number" ? row.age : null,
      depthChartPosition:
        typeof row.depthChartPosition === "number"
          ? row.depthChartPosition
          : null,
      catalog_rank:
        typeof row.catalog_rank === "number" ? row.catalog_rank : null,
      catalogValuationTier: row.catalogValuationTier ?? null,
      projection_keys: row.projection ? Object.keys(row.projection) : [],
      batting_hr: row?.projection?.batting?.hr ?? null,
      pitching_strikeouts: row?.projection?.pitching?.strikeouts ?? null,
    });
  }
  // Dump the ENTIRE Judge row to see what structuredClone preserves vs. drops.
  const judge = rows.find((r) => r.mlbId === 592450);
  if (judge) {
    console.log(`---- full Judge row (${label}) keys + types ----`);
    const desc: Record<string, string> = {};
    for (const [k, v] of Object.entries(judge)) {
      const t = v === null ? "null" : typeof v;
      const ctor = v && typeof v === "object" ? (v.constructor?.name ?? "?") : "";
      desc[k] = ctor && t === "object" ? `${t}<${ctor}>` : t;
    }
    console.log(JSON.stringify(desc, null, 2));
    console.log(`---- full Judge row (${label}) JSON ----`);
    console.log(JSON.stringify(judge, null, 2));
  }
  const snap: Snapshot = {
    count: rows.length,
    with_projection,
    with_batting_hr,
    with_pitching_strikeouts,
    with_age,
    with_depth_chart_position,
    samples,
  };
  console.log(`==== snapshot: ${label} ====`);
  console.log(
    JSON.stringify(
      {
        count: snap.count,
        with_projection,
        with_batting_hr,
        with_pitching_strikeouts,
        with_age,
        with_depth_chart_position,
      },
      null,
      2
    )
  );
  console.log(JSON.stringify(samples, null, 2));
  return snap;
}

function summariseBaselines(label: string, rows: any[]): void {
  const valueSet = new Set<number>();
  for (const r of rows) valueSet.add(Number(r.value ?? r.baseline_value ?? 0));
  const min = Math.min(...rows.map((r) => Number(r.value ?? 0)));
  const max = Math.max(...rows.map((r) => Number(r.value ?? 0)));
  console.log(
    `==== baseline pool: ${label} — ${rows.length} rows, distinct values=${valueSet.size}, min=${min}, max=${max}, collapsed=${isBaselineOutputCollapsed(rows)} ====`
  );
}

function diff(a: Snapshot, b: Snapshot): void {
  const fields: (keyof Snapshot)[] = [
    "count",
    "with_projection",
    "with_batting_hr",
    "with_pitching_strikeouts",
    "with_age",
    "with_depth_chart_position",
  ];
  console.log("==== diff snapshot1 -> snapshot2 ====");
  for (const f of fields) {
    if (a[f] !== b[f]) {
      console.log(`  ${String(f)}: ${a[f]} -> ${b[f]}   (DELTA)`);
    } else {
      console.log(`  ${String(f)}: ${a[f]} (unchanged)`);
    }
  }
  for (let i = 0; i < a.samples.length; i++) {
    const sa = a.samples[i];
    const sb = b.samples[i];
    if (!sb || sa.mlbId !== sb.mlbId) continue;
    const samaplFields: (keyof typeof sa)[] = [
      "age",
      "depthChartPosition",
      "catalog_rank",
      "catalogValuationTier",
      "batting_hr",
      "pitching_strikeouts",
    ];
    for (const f of samaplFields) {
      if (sa[f] !== sb[f]) {
        console.log(
          `  sample[${sa.name}].${String(f)}: ${JSON.stringify(sa[f])} -> ${JSON.stringify(sb[f])}   (DELTA)`
        );
      }
    }
    const ak = sa.projection_keys.sort().join(",");
    const bk = sb.projection_keys.sort().join(",");
    if (ak !== bk) {
      console.log(
        `  sample[${sa.name}].projection_keys: [${ak}] -> [${bk}]   (DELTA)`
      );
    }
  }
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  invalidateCatalogCache();
  console.log("isCatalogCacheDisabled:", isCatalogCacheDisabled());
  console.log("AMETHYST_DISABLE_CATALOG_CACHE:", process.env.AMETHYST_DISABLE_CATALOG_CACHE ?? "(unset)");
  console.log("AMETHYST_CATALOG_CACHE_DISABLED:", process.env.AMETHYST_CATALOG_CACHE_DISABLED ?? "(unset)");
  console.log("AMETHYST_CATALOG_CACHE_TTL_MS env:", process.env.AMETHYST_CATALOG_CACHE_TTL_MS ?? "(unset)");
  console.log("VITEST env:", process.env.VITEST);
  console.log("Effective TTL ms:", getCatalogCacheTtlMs());

  await mongoose.connect(uri, scriptMongoConnectOptions());

  // ---- 1. Cold cache miss (warm-equivalent path)
  const t0 = Date.now();
  const cold = await loadMongoCatalogForEngine(undefined, {
    skipMlbHydration: true,
  });
  console.log(`cold load: ${cold.length} rows in ${Date.now() - t0}ms`);
  const snap1 = snapshotRows("after cold miss (warm equivalent)", cold);

  // ---- 2. Build the same request body that prod probes send.
  const fixturePath = path.resolve(
    __dirname,
    "../test-fixtures/player-api/checkpoints/pre_draft.json"
  );
  const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const parsed = parseValuationRequest(raw);
  if (!parsed.success) {
    console.error("Failed to parse fixture", parsed.errors);
    process.exit(1);
  }

  // ---- 3. First workflow run on the cold-loaded rows.
  const wf1 = executeValuationWorkflow(cold, parsed.normalized);
  if (!wf1.ok) {
    console.error("Workflow 1 failed:", wf1.issues);
  } else {
    const r = wf1.response;
    const distinct = new Set(r.valuations.map((v) => v.auction_value)).size;
    console.log(
      `workflow #1 (cold rows): valuations=${r.valuations.length}, distinct_auction=${distinct}, inflation_factor=${r.inflation_factor}, warnings=${r.valuation_context_warnings?.length ?? 0}, top1=${r.valuations.sort((a, b) => (b.auction_value ?? 0) - (a.auction_value ?? 0))[0]?.name} $${r.valuations[0]?.auction_value ?? "?"}`
    );
  }

  // ---- 4. Cache hit — call load again, MUST return correct data.
  const t1 = Date.now();
  const hot = await loadMongoCatalogForEngine(undefined, {
    skipMlbHydration: true,
  });
  console.log(`cache-hit load: ${hot.length} rows in ${Date.now() - t1}ms`);
  const snap2 = snapshotRows("after cache hit (post-workflow-1)", hot);
  diff(snap1, snap2);

  // ---- 5. Second workflow run on the cache-hit rows.
  const wf2 = executeValuationWorkflow(hot, parsed.normalized);
  if (!wf2.ok) {
    console.error("Workflow 2 failed:", wf2.issues);
  } else {
    const r = wf2.response;
    const distinct = new Set(r.valuations.map((v) => v.auction_value)).size;
    const top = [...r.valuations].sort(
      (a, b) => (b.auction_value ?? 0) - (a.auction_value ?? 0)
    )[0];
    console.log(
      `workflow #2 (cache-hit rows): valuations=${r.valuations.length}, distinct_auction=${distinct}, inflation_factor=${r.inflation_factor}, warnings=${r.valuation_context_warnings?.length ?? 0}, top1=${top?.name} $${top?.auction_value ?? "?"}`
    );
  }

  // ---- 6. One more pass to be sure (third workflow on rows from third cache hit).
  const hot2 = await loadMongoCatalogForEngine(undefined, {
    skipMlbHydration: true,
  });
  const wf3 = executeValuationWorkflow(hot2, parsed.normalized);
  if (wf3.ok) {
    const r = wf3.response;
    const distinct = new Set(r.valuations.map((v) => v.auction_value)).size;
    const top = [...r.valuations].sort(
      (a, b) => (b.auction_value ?? 0) - (a.auction_value ?? 0)
    )[0];
    console.log(
      `workflow #3 (cache-hit rows, second hit): distinct_auction=${distinct}, inflation_factor=${r.inflation_factor}, warnings=${r.valuation_context_warnings?.length ?? 0}, top1=${top?.name} $${top?.auction_value ?? "?"}`
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
