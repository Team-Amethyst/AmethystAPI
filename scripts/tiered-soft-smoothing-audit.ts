/**
 * Curve metrics + top 75 rows per checkpoint (adaptive_surplus_v1).
 *
 *   npx tsx scripts/tiered-soft-smoothing-audit.ts
 */
import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import {
  ENGINE_CHECKPOINT_IDS,
  resolveDraftCheckpointFixturePath,
  type EngineCheckpointId,
} from "../src/lib/checkpointSlotReconciliation";
import type { ValuationResponse, ValuedPlayer } from "../src/types/brain";

const OUT = path.resolve(__dirname, "../tmp/tiered-soft-smoothing-audit.json");
const CHECKPOINTS: EngineCheckpointId[] = [
  "pre_draft",
  ...ENGINE_CHECKPOINT_IDS.filter((id) => id !== "pre_draft"),
];

function loadCheckpoint(id: EngineCheckpointId) {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath(id), "utf8")
  );
  return buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
}

function metrics(auctionValues: number[]) {
  const avs = auctionValues;
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
  let maxAdjDrop = 0;
  let maxAdjPct = 0;
  for (let i = 1; i < avs.length; i++) {
    const drop = avs[i - 1]! - avs[i]!;
    maxAdjDrop = Math.max(maxAdjDrop, drop);
    if (avs[i - 1]! > 0) maxAdjPct = Math.max(maxAdjPct, drop / avs[i - 1]!);
  }
  const rounded = avs.map((v) => Math.round(v));
  let run = 1;
  let maxShelf = 1;
  for (let i = 1; i < rounded.length; i++) {
    if (rounded[i] === rounded[i - 1]) {
      run++;
      maxShelf = Math.max(maxShelf, run);
    } else run = 1;
  }
  const plateau48 = rounded.filter((v) => v === 48).length;
  return {
    top_value: avs[0] ?? 0,
    top_10_avg: avg(avs.slice(0, 10)),
    top_25_avg: avg(avs.slice(0, 25)),
    median_top_75: avs[Math.floor(avs.length / 2)] ?? 0,
    max_adjacent_drop: maxAdjDrop,
    max_adjacent_pct_drop: maxAdjPct,
    max_whole_dollar_shelf_len: maxShelf,
    count_at_48: plateau48,
    surplus_conservation_delta: 0,
  };
}

function top75(resp: ValuationResponse) {
  return [...resp.valuations]
    .sort((a, b) => b.auction_value - a.auction_value)
    .slice(0, 75)
    .map((v, i) => {
      const ve = v.valuation_explain;
      return {
        rank: i + 1,
        player_id: v.player_id,
        name: v.name,
        position: v.position,
        auction_value: v.auction_value,
        baseline_value: v.baseline_value,
        auction_tier: v.auction_tier,
        baseline_tier: v.baseline_tier,
        surplus_basis: ve?.surplus_basis,
        internal_allocation_mode: resp.internal_allocation_mode,
        curve_guardrails_applied: resp.curve_guardrails_applied,
        auction_curve_tier: ve?.auction_curve_tier,
      };
    });
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let pool;
  try {
    pool = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const valuationPool = filterValuationUniverse(pool, { leagueScope: "Mixed" });
  const report: Record<string, unknown> = {};

  for (const id of CHECKPOINTS) {
    const input = loadCheckpoint(id);
    const poolInj = applyInjuryOverridesToPool(
      valuationPool,
      input.injury_overrides
    );
    const result = executeValuationWorkflow(poolInj, {
      ...input,
      inflation_model: "replacement_slots_v2",
      auction_curve_model: "adaptive_surplus_v1",
      explain_valuation_rows: true,
      deterministic: true,
      seed: 42,
    });
    if (!result.ok) throw new Error(`${id}: ${result.issues.join("; ")}`);
    const resp = result.response;
    const rows = top75(resp);
    report[id] = {
      metadata: {
        auction_curve_reason: resp.auction_curve_reason,
        internal_allocation_mode: resp.internal_allocation_mode,
        curve_guardrails_applied: resp.curve_guardrails_applied,
        surplus_conservation_delta: resp.surplus_conservation_delta,
        selected_weights: resp.selected_weights,
      },
      metrics: metrics(
        rows.map((r) => r.auction_value).sort((a, b) => b - a)
      ),
      top75: rows,
      ranks_25_45: rows.filter((r) => r.rank >= 25 && r.rank <= 45),
    };
    console.log(`\n=== ${id} ===`);
    console.log(JSON.stringify(report[id].metrics, null, 2));
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log("\nWrote", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
