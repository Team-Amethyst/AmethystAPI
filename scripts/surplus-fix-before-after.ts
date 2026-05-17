/**
 * Before/after report for UTIL/BN surplus fix (pre_draft fixture).
 *   npx tsx scripts/surplus-fix-before-after.ts
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

const NAMES = [
  "José Ramírez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Pete Alonso",
  "Nick Kurtz",
  "Junior Caminero",
  "Julio Rodríguez",
  "Bobby Witt Jr.",
  "Aaron Judge",
  "Tarik Skubal",
  "Jarren Duran",
  "Riley Greene",
  "Drew Rasmussen",
  "Bryan Woo",
  "Anthony Volpe",
  "Camilo Doval",
  "Will Warren",
];

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
  const bySb = [...r.valuations]
    .filter((v) => (r.draftable_player_ids ?? []).includes(v.player_id))
    .map((v) => ({
      id: v.player_id,
      sb: v.valuation_explain?.surplus_basis ?? 0,
    }))
    .sort((a, b) => b.sb - a.sb);
  const sbRank = new Map(bySb.map((x, i) => [x.id, i + 1]));

  const report = {
        curve: {
          mode: r.internal_allocation_mode,
          reason: r.auction_curve_reason,
          total_surplus_mass: r.total_surplus_mass,
          inflation_factor: r.inflation_factor,
        },
        replacement_values: r.replacement_values_by_slot_or_position,
        players: NAMES.map((name) => {
          const v = r.valuations.find((x) => x.name === name);
          if (!v) return { name, missing: true };
          const ve = v.valuation_explain;
          return {
            name,
            baseline_value: v.baseline_value,
            replacement_key_used: ve?.replacement_key_used,
            replacement_value_used: ve?.replacement_value_used,
            surplus_basis: ve?.surplus_basis,
            surplus_basis_rank: sbRank.get(v.player_id) ?? null,
            auction_curve_tier: ve?.auction_curve_tier,
            auction_value: v.auction_value,
            auction_rank: v.auction_rank,
          };
        }),
  };
  const outPath = process.argv[2];
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
