/**
 * Stage 3b Part 1 — SP diagnosis across checkpoints (local Mongo + nested fixtures).
 *
 *   pnpm audit:stage3b-diagnosis
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import {
  ENGINE_CHECKPOINTS,
  buildCatalogEnvelope,
  type AuditCheckpointId,
} from "../src/lib/stage2ValuationAudit/helpers";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import {
  boardShapeMetrics,
  spDiagnosisRow,
  workflowWithStage3b,
  SP_DIAGNOSIS_NAMES,
} from "../src/lib/stage3bAudit/helpers";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { readFileSync } from "fs";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp/stage3b-pitcher-diagnosis.json");

function classifySpIssue(rows: ReturnType<typeof spDiagnosisRow>[]): string[] {
  const flags = new Set<string>();
  for (const r of rows) {
    if (!r.valuation_row) {
      flags.add("G_or_missing_row");
      continue;
    }
    const sb = r.surplus_basis ?? 0;
    const av = r.auction_value ?? 0;
    const repl = r.replacement_value_used ?? 0;
    const base = r.baseline_value ?? 0;
    if (sb > 0 && av <= 3 && r.in_draftable_pool) {
      if (base > 0 && base < repl + 2) flags.add("A_replacement_level_high_vs_baseline");
      if (sb < 12) flags.add("B_low_surplus_mass_or_tier_budget");
      if (sb >= 12 && av <= 3) flags.add("E_auction_curve_suppresses_sp_surplus");
    }
    if (!r.in_draftable_pool && sb > 20 && av <= 1) {
      flags.add("F_late_pool_skew_non_draftable_inflation");
    }
    if (r.auction_tier === "depth" && sb >= 15) flags.add("C_tier_depth_despite_surplus");
  }
  if (flags.size === 0) flags.add("mixed_review");
  return [...flags];
}

async function runCheckpoint(
  poolInj: ReturnType<typeof applyInjuryOverridesToPool>,
  cp: AuditCheckpointId,
  pathMode: "fixture" | "draftroom",
) {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath(cp), "utf8"),
  );
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
  const body =
    pathMode === "draftroom"
      ? buildCatalogEnvelope(nested, poolInj)
      : nested;
  const out = executeValuationWorkflow(
    poolInj,
    workflowWithStage3b(body),
    {},
    {},
  );
  if (!out.ok) throw new Error(JSON.stringify(out.issues));
  const r = out.response;
  const spRows = SP_DIAGNOSIS_NAMES.map((n) => spDiagnosisRow(r, n));
  return {
    checkpoint: cp,
    path: pathMode,
    board: boardShapeMetrics(r),
    sp_players: spRows,
    sp_issue_flags: classifySpIssue(spRows),
  };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  const pool = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
  await mongoose.disconnect();

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

  const root_causes = [
    "C: Hybrid lift is hitter-only (scarceSlotsOnly excludes SP/RP) — pitchers rely on slot marginal surplus only.",
    "E: Tiered/linear auction curve can suppress positive SP surplus_basis when inflation factor is floored (healthy_linear ~0.25).",
    "A: SP replacement percentiles (~0.35) keep replacement high vs many pitcher baselines → low slot marginal.",
    "F: Late checkpoints re-rank SP into top surplus_basis while out of draftable pool → display $1 rows.",
  ];

  const fixture: Record<string, unknown> = {};
  const draftroom: Record<string, unknown> = {};
  for (const cp of ENGINE_CHECKPOINTS) {
    fixture[cp] = await runCheckpoint(poolInj, cp, "fixture");
    draftroom[cp] = await runCheckpoint(poolInj, cp, "draftroom");
  }

  const report = {
    generated_at: new Date().toISOString(),
    stage: "3b_diagnosis",
    baseline: "Stage 3 default (no stage3b_calibration)",
    root_cause_hypotheses: root_causes,
    nested_fixture: fixture,
    draftroom_catalog_envelope: draftroom,
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ wrote: OUT }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
