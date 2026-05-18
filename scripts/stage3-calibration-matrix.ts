/**
 * Stage 3 calibration matrix — Stage 2 vs Stage 3 hybrid on Stage 3 curve code.
 *
 *   pnpm audit:stage3-matrix
 *
 * Requires MONGO_URI + canonical Draft checkpoints.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import {
  ENGINE_CHECKPOINTS,
  workflowBody,
  type AuditCheckpointId,
} from "../src/lib/stage2ValuationAudit/helpers";
import { trackedCanonicalNames } from "../src/lib/stage2ValuationAudit/trackedPlayers";
import {
  STAGE2_HYBRID_SURPLUS_CALIBRATION,
} from "../src/services/replacementSlotsV2Config";
import type { HybridSurplusCalibration } from "../src/services/replacementSlotsV2Config";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { ValuationResponse } from "../src/types/valuation";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp/stage3-calibration-matrix.json");

const SCENARIOS: { id: string; hybrid: HybridSurplusCalibration | undefined }[] = [
  { id: "stage3_default", hybrid: undefined },
  { id: "stage2_hybrid_control", hybrid: STAGE2_HYBRID_SURPLUS_CALIBRATION },
];

function boardMetrics(r: ValuationResponse) {
  const ids = new Set(r.draftable_player_ids ?? []);
  const draftable = r.valuations
    .filter((v) => ids.has(v.player_id))
    .sort((a, b) => b.auction_value - a.auction_value);
  const vals = draftable.map((v) => v.auction_value);
  let drop25 = 0;
  for (let i = 0; i < Math.min(24, vals.length - 1); i++) {
    drop25 = Math.max(drop25, vals[i]! - vals[i + 1]!);
  }
  return {
    draftable_pool_size: r.draftable_pool_size,
    inflation_factor: r.inflation_factor,
    total_surplus_mass: r.total_surplus_mass,
    UTIL: r.replacement_values_by_slot_or_position?.UTIL,
    max_auction: vals[0] ?? 0,
    top25_avg:
      vals.slice(0, 25).reduce((s, v) => s + v, 0) / Math.min(25, vals.length || 1),
    plateau_48: vals.filter((v) => v >= 47.5 && v <= 48.5).length,
    ge30: vals.filter((v) => v >= 30).length,
    ge20: vals.filter((v) => v >= 20).length,
    drop25,
    endgame_ge20:
      (r.remaining_slots ?? 99) <= 10
        ? vals.filter((v) => v >= 20).length
        : null,
    phase: r.curve_inputs?.phase,
    curve_reason: r.auction_curve_reason,
  };
}

function trackedRows(r: ValuationResponse) {
  const ids = new Set(r.draftable_player_ids ?? []);
  return trackedCanonicalNames().map((name) => {
    const norm = name.normalize("NFD").replace(/\p{M}/gu, "");
    const v = r.valuations.find(
      (x) => x.name?.normalize("NFD").replace(/\p{M}/gu, "") === norm,
    );
    if (!v) return { name, valuation_row: false };
    return {
      name: v.name,
      auction_value: v.auction_value,
      auction_rank: v.auction_rank,
      surplus_basis: v.valuation_explain?.surplus_basis,
      assigned_slot: v.valuation_explain?.replacement_key_used,
      tier: v.valuation_explain?.auction_curve_tier,
      in_draftable_pool: ids.has(v.player_id),
    };
  });
}

function runCheckpoint(
  poolInj: ReturnType<typeof applyInjuryOverridesToPool>,
  cp: AuditCheckpointId,
  hybrid: HybridSurplusCalibration | undefined,
): ValuationResponse {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath(cp), "utf8"),
  );
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
  const out = executeValuationWorkflow(
    poolInj,
    workflowBody({
      ...nested,
      ...(hybrid ? { hybrid_surplus_calibration: hybrid } : {}),
    }),
    {},
    {},
  );
  if (!out.ok) throw new Error(JSON.stringify(out.issues));
  return out.response;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required for stage3 matrix");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  const pool = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
  await mongoose.disconnect();

  if (pool.length < 100) {
    throw new Error(
      `Mongo catalog too small (${pool.length} players). Run sync-players before matrix audit.`,
    );
  }

  const preRaw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8"),
  );
  const preNested = buildNormalizedFromNested(
    nestedValuationBodySchema.parse(preRaw),
  );
  const poolInj = applyInjuryOverridesToPool(
    filterValuationUniverse(pool, { leagueScope: preNested.league_scope }),
    preNested.injury_overrides,
  );

  const results: Record<string, Record<string, unknown>> = {};
  for (const sc of SCENARIOS) {
    const byCp: Record<string, unknown> = {};
    for (const cp of ENGINE_CHECKPOINTS) {
      const r = runCheckpoint(poolInj, cp, sc.hybrid);
      byCp[cp] = { board: boardMetrics(r), tracked: trackedRows(r) };
    }
    results[sc.id] = byCp;
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        curve_code: "Stage 3 (late_draft spread + hybrid auction tier)",
        scenarios: results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ wrote: OUT }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
