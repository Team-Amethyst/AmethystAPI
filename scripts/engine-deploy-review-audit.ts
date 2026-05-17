/**
 * Pre-deploy Engine review: production snapshot vs local bundle.
 *   npx tsx scripts/engine-deploy-review-audit.ts [out.json]
 */
import { config } from "dotenv";
config({ quiet: true });
import { readFileSync, writeFileSync } from "fs";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";

const TRACKED = [
  "Aaron Judge",
  "Julio Rodríguez",
  "Julio Rodriguez",
  "Bobby Witt Jr.",
  "José Ramírez",
  "Jose Ramirez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Tarik Skubal",
  "Anthony Volpe",
  "Austin Wells",
  "Will Warren",
  "Camilo Doval",
  "Fernando Cruz",
  "Spencer Jones",
];

const PROD_SNAPSHOT =
  "/Users/ssperrottet/dev/AmethystDraft/apps/tmp/pre-deploy-catalog-verification.json";

function pickProdRow(prod: Record<string, unknown>, name: string) {
  const checkpoints = prod.valuation_by_checkpoint as Record<
    string,
    { deep_dive_players?: Array<Record<string, unknown>>; replacement_values_by_slot?: Record<string, number> }
  >;
  const pre = checkpoints?.pre_draft;
  const players = pre?.deep_dive_players ?? [];
  const row = players.find((p) => p.name === name);
  return { row, util: pre?.replacement_values_by_slot?.UTIL };
}

async function main() {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8"),
  );
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
  await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
  const pool = await loadMongoCatalogForEngine(undefined);
  await mongoose.disconnect();

  const poolInj = applyInjuryOverridesToPool(
    filterValuationUniverse(pool, { leagueScope: nested.league_scope }),
    nested.injury_overrides,
  );

  const out = executeValuationWorkflow(
    poolInj,
    {
      ...nested,
      deterministic: true,
      seed: 42,
      inflation_model: "replacement_slots_v2",
      auction_curve_model: "adaptive_surplus_v1",
      explain_valuation_rows: true,
    },
    {},
    {},
  );
  if (!out.ok) throw new Error("valuation failed");
  const r = out.response;
  const draftable = new Set(r.draftable_player_ids ?? []);
  const repl = r.replacement_values_by_slot_or_position ?? {};

  let prod: Record<string, unknown> = {};
  try {
    prod = JSON.parse(readFileSync(PROD_SNAPSHOT, "utf8"));
  } catch {
    prod = {};
  }

  const preCp = (
    prod.valuation_by_checkpoint as Record<string, { replacement_values_by_slot?: Record<string, number> }>
  )?.pre_draft;
  const prodUtil = preCp?.replacement_values_by_slot?.UTIL;

  const players = TRACKED.map((name) => {
    const v = r.valuations.find((x) => x.name === name);
    const cat = poolInj.find((p) => p.name === name);
    const prodPick = pickProdRow(prod, name);
    const ve = v?.valuation_explain;
    return {
      name,
      production: prodPick.row
        ? {
            replacement_key_used: prodPick.row.replacement_key_used,
            surplus_basis: prodPick.row.surplus_basis,
            auction_value: prodPick.row.auction_value,
            in_draftable_pool: prodPick.row.in_draftable_pool,
            has_auction_value: prodPick.row.has_auction_value,
          }
        : null,
      local: v
        ? {
            replacement_key_used: ve?.replacement_key_used ?? null,
            replacement_value_used: ve?.replacement_value_used ?? null,
            surplus_basis: ve?.surplus_basis ?? null,
            auction_value: v.auction_value,
            in_draftable_pool: draftable.has(v.player_id),
            valuation_row: true,
            catalog_present: Boolean(cat),
            catalog_valuation_eligible: cat?.valuation_eligible !== false,
          }
        : {
            replacement_key_used: null,
            replacement_value_used: null,
            surplus_basis: null,
            auction_value: null,
            in_draftable_pool: false,
            valuation_row: false,
            catalog_present: Boolean(cat),
            catalog_valuation_eligible: cat?.valuation_eligible !== false,
          },
    };
  });

  const preDraftCheckpoint = JSON.parse(
    readFileSync("/tmp/checkpoint-coverage-engine-review.json", "utf8"),
  ).scenarios?.find((s: { checkpoint: string }) => s.checkpoint === "pre_draft");

  const report = {
    generated_at: new Date().toISOString(),
    acceptance: {
      local_util_replacement: repl.UTIL ?? repl.Util,
      production_util_replacement: prodUtil,
      draftable_pool_size: r.draftable_player_ids?.length ?? 0,
      plateau_at_48: preDraftCheckpoint?.plateau_at_48 ?? null,
      surplus_conservation_delta: preDraftCheckpoint?.surplus_conservation_delta ?? null,
      max_auction_pre_draft: preDraftCheckpoint?.max_auction ?? null,
    },
    players,
  };

  const outPath = process.argv[2] ?? "/tmp/engine-deploy-review-audit.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
