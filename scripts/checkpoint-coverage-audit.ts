/**
 * Multi-checkpoint coverage audit (canonical Draft fixtures, raw pool).
 *   npx tsx scripts/checkpoint-coverage-audit.ts [out.json]
 */
import { config } from "dotenv";
config({ quiet: true });
import { readFileSync, writeFileSync } from "fs";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";
import type { EngineCheckpointId } from "../src/lib/checkpointSlotReconciliation";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { sumAuctionValueForDraftablePool } from "../src/lib/rosterUniverseValuationCalibration";
import { computeReplacementSlotsV2 } from "../src/services/replacementSlotsV2";
import { getPlayerId } from "../src/lib/playerId";
import { buildRosteredPlayersForSlotEngine } from "../src/lib/rosteredPlayersForSlots";
import { computeBudgetRemaining } from "../src/services/inflationModel";
import mongoose from "mongoose";

const CHECKPOINTS: EngineCheckpointId[] = [
  "pre_draft",
  "after_pick_10",
  "after_pick_50",
  "after_pick_100",
  "after_pick_130",
  "finished_league",
];

const TRACKED = [
  "Aaron Judge",
  "Julio Rodríguez",
  "Bobby Witt Jr.",
  "José Ramírez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Jarren Duran",
  "Riley Greene",
  "Tarik Skubal",
  "Bryan Woo",
  "Drew Rasmussen",
  "Garrett Crochet",
  "Andrés Muñoz",
  "David Bednar",
  "Emmanuel Clase",
  "Yordan Alvarez",
  "Roman Anthony",
];

function bucketCounts(vals: number[]) {
  return {
    ge40: vals.filter((v) => v >= 40).length,
    ge30: vals.filter((v) => v >= 30).length,
    ge20: vals.filter((v) => v >= 20).length,
    ge10: vals.filter((v) => v >= 10).length,
    minBid: vals.filter((v) => v <= 1.05).length,
  };
}

function largestDropTop75(sorted: { auction_value: number }[]) {
  let maxDrop = 0;
  for (let i = 0; i < Math.min(74, sorted.length - 1); i++) {
    const d = sorted[i]!.auction_value - sorted[i + 1]!.auction_value;
    if (d > maxDrop) maxDrop = d;
  }
  return maxDrop;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
  const pool = await loadMongoCatalogForEngine(undefined);
  await mongoose.disconnect();

  const scenarios: Record<string, unknown>[] = [];
  const playersByCheckpoint: Record<string, unknown> = {};

  for (const cp of CHECKPOINTS) {
    const raw = JSON.parse(
      readFileSync(resolveDraftCheckpointFixturePath(cp), "utf8")
    );
    const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
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
    if (!out.ok) {
      scenarios.push({ checkpoint: cp, error: out.issues });
      continue;
    }
    const r = out.response;
    const draftable = new Set(r.draftable_player_ids ?? []);
    const draftableVals = r.valuations
      .filter((v) => draftable.has(v.player_id))
      .map((v) => v.auction_value);
    const sorted = [...r.valuations]
      .filter((v) => draftable.has(v.player_id))
      .sort((a, b) => b.auction_value - a.auction_value);
    const top25 = sorted.slice(0, 25).map((v, i) => ({
      rank: i + 1,
      name: v.name,
      auction_value: v.auction_value,
      tier: v.valuation_explain?.auction_curve_tier,
    }));
    const { sum: draftableSum } = sumAuctionValueForDraftablePool(
      r.valuations,
      r
    );
    const surplusCash = r.surplus_cash ?? 0;
    const minBid = r.min_bid ?? 1;
    let surplusConservation = 0;
    for (const v of r.valuations) {
      if (!draftable.has(v.player_id)) continue;
      surplusConservation += Math.max(0, v.auction_value - minBid);
    }
    const plateau48 = draftableVals.filter(
      (v) => v >= 47.5 && v <= 48.5
    ).length;

    const baselineById = new Map(
      poolInj.map((p) => [getPlayerId(p), 0])
    );
    for (const v of r.valuations) {
      baselineById.set(v.player_id, v.baseline_value);
    }
    const undrafted = poolInj.filter(
      (p) => !nested.drafted_players.some((d) => d.player_id === getPlayerId(p))
    );
    const v2 = computeReplacementSlotsV2(
      undrafted,
      buildRosteredPlayersForSlotEngine(nested),
      nested.roster_slots,
      nested.num_teams,
      computeBudgetRemaining({
        draftedPlayers: nested.drafted_players,
        totalBudgetPerTeam: nested.total_budget,
        numTeams: nested.num_teams,
      }),
      new Map(
        r.valuations.map((v) => [v.player_id, v.baseline_value])
      ),
      { deterministic: true, seed: 42 }
    );

    scenarios.push({
      checkpoint: cp,
      total_surplus_mass: r.total_surplus_mass,
      inflation_factor: r.inflation_factor,
      draftable_pool_size: r.draftable_pool_size,
      remaining_slots: r.remaining_slots,
      surplus_cash: surplusCash,
      draftable_auction_sum: draftableSum,
      surplus_conservation_delta: surplusCash - surplusConservation,
      buckets: bucketCounts(draftableVals),
      max_auction: sorted[0]?.auction_value ?? 0,
      top5_avg:
        sorted.slice(0, 5).reduce((s, v) => s + v.auction_value, 0) / 5,
      top10_avg:
        sorted.slice(0, 10).reduce((s, v) => s + v.auction_value, 0) / 10,
      top25_avg:
        sorted.slice(0, 25).reduce((s, v) => s + v.auction_value, 0) / 25,
      median_draftable:
        draftableVals.length > 0
          ? [...draftableVals].sort((a, b) => a - b)[
              Math.floor(draftableVals.length / 2)
            ]
          : 0,
      largest_drop_top75: largestDropTop75(sorted),
      plateau_at_48: plateau48,
      top25,
    });

    playersByCheckpoint[cp] = TRACKED.map((name) => {
      const v = r.valuations.find((x) => x.name === name);
      if (!v) return { name, missing: true };
      const id = v.player_id;
      const lift = v2.playerIdToHybridLift?.get(id) ?? 0;
      return {
        name,
        auction_value: v.auction_value,
        surplus_basis: v.valuation_explain?.surplus_basis,
        assigned_slot: v2.playerIdToAssignedSlot?.get(id),
        replacement_at_assignment: v2.playerIdToMarginalReplacement?.get(id),
        tier: v.valuation_explain?.auction_curve_tier,
        hybrid_lift: lift > 0 ? lift : null,
        replacement_key_explain: v.valuation_explain?.replacement_key_used,
        plausible:
          v.auction_value <= 1.05 && (v.baseline_value ?? 0) > 50
            ? "suspicious_floor"
            : (v.valuation_explain?.surplus_basis ?? 0) >=
                  (v.baseline_value ?? 0) - 0.5 &&
                v.valuation_explain?.replacement_key_used === "UTIL"
              ? "suspicious_util_baseline_proxy"
              : "ok",
      };
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    fixture_source: "AmethystDraft canonical nested checkpoints",
    pool: "raw Mongo catalog via executeValuationWorkflow",
    scenarios,
    players_by_checkpoint: playersByCheckpoint,
  };
  const outPath = process.argv[2] ?? "/tmp/checkpoint-coverage-audit.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ wrote: outPath, checkpoints: scenarios.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
