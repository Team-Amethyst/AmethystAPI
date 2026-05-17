/**
 * Surplus mass + Judge deep dive (pre_draft fixture).
 *   npx tsx scripts/surplus-marginal-investigation.ts
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
  const repl = r.replacement_values_by_slot_or_position ?? {};
  const rosterKeys = new Set(Object.keys(repl));

  const draftable = new Set(r.draftable_player_ids ?? []);
  const sbRows = r.valuations
    .filter((v) => draftable.has(v.player_id))
    .map((v) => ({
      name: v.name,
      sb: r.valuations.find((x) => x.player_id === v.player_id)
        ?.valuation_explain?.surplus_basis ?? 0,
    }))
    .sort((a, b) => b.sb - a.sb);

  const positive = sbRows.filter((x) => x.sb > 0);
  const zero = sbRows.filter((x) => x.sb <= 0);

  const judge = r.valuations.find((v) => v.name === "Aaron Judge");
  if (judge) {
    const ve = judge.valuation_explain;
    const tokens = ve?.effective_positions ?? [];
    const perSlot = eligibleAuctionSurplusSlots(tokens, rosterKeys).map(
      (slot) => ({
        slot,
        repl: repl[slot] ?? 0,
        surplus: Math.max(0, judge.baseline_value - (repl[slot] ?? 0)),
        fits: fitsRosterSlot(slot, tokens),
      }),
    );
    console.log(
      JSON.stringify(
        {
          judge: {
            player_id: judge.player_id,
            baseline_value: judge.baseline_value,
            auction_value: judge.auction_value,
            auction_rank: judge.auction_rank,
            in_draftable_pool: draftable.has(judge.player_id),
            greedy_assigned_slot: ve?.replacement_key_used,
            marginal_replacement: ve?.replacement_value_used,
            surplus_basis: ve?.surplus_basis,
            auction_curve_tier: ve?.auction_curve_tier,
            effective_positions: tokens,
            per_eligible_slot: perSlot,
            percentile_repl_surplus: maxSurplusOverSlots(
              judge.baseline_value,
              tokens,
              repl,
              rosterKeys,
            ),
          },
        },
        null,
        2,
      ),
    );
  }

  console.log(
    JSON.stringify(
      {
        curve: {
          mode: r.internal_allocation_mode,
          reason: r.auction_curve_reason,
          total_surplus_mass: r.total_surplus_mass,
          inflation_factor: r.inflation_factor,
          draftable_pool_size: r.draftable_pool_size,
        },
        replacement_values: repl,
        surplus_mass: {
          positive_count: positive.length,
          zero_count: zero.length,
          top25_sb: sbRows.slice(0, 25),
          bottom5_sb: sbRows.slice(-5),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
