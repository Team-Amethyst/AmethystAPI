/**
 * Elite hitter surplus audit (pre_draft fixture).
 *   npx tsx scripts/elite-hitter-surplus-audit.ts
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import {
  eligibleAuctionSurplusSlots,
  fitsRosterSlot,
  maxSurplusOverSlots,
  playerTokensFromLean,
} from "../src/lib/fantasyRosterSlots";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";

const ELITE_HITTERS = [
  "Aaron Judge",
  "Julio Rodríguez",
  "Bobby Witt Jr.",
  "José Ramírez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Jarren Duran",
  "Riley Greene",
];

function categoryProfile(
  components: { projection_component?: number; scarcity_component?: number } | undefined
) {
  if (!components) return null;
  return {
    projection: components.projection_component,
    scarcity: components.scarcity_component,
  };
}

async function main() {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8")
  );
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
  await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
  const pool = await loadMongoCatalogForEngine(undefined);
  await mongoose.disconnect();
  const poolInj = applyInjuryOverridesToPool(
    filterValuationUniverse(pool, { leagueScope: nested.league_scope }),
    nested.injury_overrides
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
    {}
  );
  if (!out.ok) throw new Error("valuation failed");
  const r = out.response;
  const repl = r.replacement_values_by_slot_or_position ?? {};
  const rosterKeys = new Set(Object.keys(repl));
  const draftable = new Set(r.draftable_player_ids ?? []);
  const bySb = [...r.valuations]
    .filter((v) => draftable.has(v.player_id))
    .map((v) => ({
      id: v.player_id,
      sb: v.valuation_explain?.surplus_basis ?? 0,
    }))
    .sort((a, b) => b.sb - a.sb);
  const sbRank = new Map(bySb.map((x, i) => [x.id, i + 1]));

  const rows = ELITE_HITTERS.map((name) => {
    const v = r.valuations.find((x) => x.name === name);
    if (!v) return { name, missing: true };
    const ve = v.valuation_explain;
    const tokens = ve?.effective_positions ?? [];
    const perSlot = eligibleAuctionSurplusSlots(tokens, rosterKeys).map((slot) => ({
      slot,
      repl: repl[slot] ?? 0,
      pool_surplus: Math.max(0, v.baseline_value - (repl[slot] ?? 0)),
      fits: fitsRosterSlot(slot, tokens),
    }));
    return {
      name,
      player_id: v.player_id,
      catalog_rank: v.catalog_rank,
      baseline_value: v.baseline_value,
      category_profile: categoryProfile(v.baseline_components),
      effective_positions: tokens,
      in_draftable_pool: draftable.has(v.player_id),
      assigned_slot: ve?.replacement_key_used,
      replacement_at_slot: ve?.replacement_value_used,
      finalized_repl_surplus: perSlot,
      max_pool_floor_surplus: maxSurplusOverSlots(
        v.baseline_value,
        tokens,
        repl,
        rosterKeys
      ),
      surplus_basis: ve?.surplus_basis,
      surplus_basis_rank: sbRank.get(v.player_id) ?? null,
      auction_curve_tier: ve?.auction_curve_tier,
      auction_value: v.auction_value,
      auction_rank: v.auction_rank,
    };
  });

  const witt = rows.find((x) => x.name === "Bobby Witt Jr.");
  const raleigh = rows.find((x) => x.name === "Cal Raleigh");

  console.log(
    JSON.stringify(
      {
        curve: {
          mode: r.internal_allocation_mode,
          total_surplus_mass: r.total_surplus_mass,
          inflation_factor: r.inflation_factor,
          draftable_pool_size: r.draftable_pool_size,
        },
        replacement_values: repl,
        elite_hitters: rows,
        witt_deep_dive: witt,
        raleigh_deep_dive: raleigh,
        top_replacement_by_slot: Object.fromEntries(
          Object.entries(repl)
            .filter(([k]) => k.toUpperCase() !== "BN")
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
        ),
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
