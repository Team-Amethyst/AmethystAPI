/**
 * Stage 3b integrated scenario matrix.
 *
 *   pnpm audit:stage3b-matrix
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
import { boardShapeMetrics } from "../src/lib/stage3bAudit/helpers";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import {
  STAGE3B_MATRIX_SCENARIOS,
  type Stage3bCalibration,
} from "../src/services/stage3bPitcherCalibration";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { ValuationResponse } from "../src/types/valuation";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp/stage3b-calibration-matrix.json");

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
  stage3b?: Stage3bCalibration,
): ValuationResponse {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath(cp), "utf8"),
  );
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
  const out = executeValuationWorkflow(
    poolInj,
    {
      ...workflowBody(nested),
      ...(stage3b ? { stage3b_calibration: stage3b } : {}),
    },
    {},
    {},
  );
  if (!out.ok) throw new Error(JSON.stringify(out.issues));
  return out.response;
}

function passesAcceptance(
  byCp: Record<
    string,
    {
      board: ReturnType<typeof boardShapeMetrics>;
      tracked: ReturnType<typeof trackedRows>;
    }
  >,
  opts?: { baselinePreBoard?: ReturnType<typeof boardShapeMetrics> },
): { pass: boolean; notes: string[] } {
  const notes: string[] = [];
  const pre = byCp.pre_draft;
  const ap10 = byCp.after_pick_10;
  const ap50 = byCp.after_pick_50;
  const ap130 = byCp.after_pick_130;
  if (!pre || !ap10 || !ap50) return { pass: false, notes: ["missing checkpoint"] };

  const witt = pre.tracked.find((t) => t.name?.includes("Witt"));
  const ramirez = pre.tracked.find((t) => t.name?.includes("Ram"));
  const judge = pre.tracked.find((t) => t.name === "Aaron Judge");
  const julio = pre.tracked.find((t) => t.name?.includes("Julio"));
  const skubal = pre.tracked.find((t) => t.name === "Tarik Skubal");
  const woo = pre.tracked.find((t) => t.name === "Bryan Woo");
  const ryan = pre.tracked.find((t) => t.name === "Joe Ryan");
  const bednar = pre.tracked.find((t) => t.name === "David Bednar");
  const spencer = pre.tracked.find((t) => t.name === "Spencer Jones");

  if ((pre.board.draftable_pool_size ?? 0) !== 113) notes.push("pool!=113");
  if ((pre.board.UTIL ?? 0) <= 50) notes.push("UTIL<=50");
  if ((pre.board.plateau_48 ?? 0) > 0) notes.push("$48 plateau");
  if ((ap130?.board.endgame_ge20 ?? 0) > 0) notes.push("endgame blow-up");

  if ((witt?.auction_value ?? 0) < 25) notes.push("Witt<25");
  if ((ramirez?.auction_value ?? 0) < 20) notes.push("Ramirez<20");
  if ((judge?.auction_value ?? 0) < 27) notes.push("Judge low");
  if ((julio?.auction_value ?? 0) < 27) notes.push("Julio low");
  if ((skubal?.auction_value ?? 0) < 18) notes.push("Skubal low");

  if ((woo?.auction_value ?? 0) < 5 && woo?.in_draftable_pool) {
    notes.push("Woo too low pre_draft");
  }
  if ((ryan?.auction_value ?? 0) < 4 && ryan?.in_draftable_pool) {
    notes.push("Ryan too low pre_draft");
  }

  if (opts?.baselinePreBoard) {
    const spDelta =
      (pre.board.sp_ge15 ?? 0) - (opts.baselinePreBoard.sp_ge15 ?? 0);
    if (spDelta > 5) notes.push("blanket SP pre_draft vs stage3");
  }

  if ((ap50.board.max_auction ?? 0) < 16) notes.push("ap50 max<16");
  if ((ap10.board.max_auction ?? 0) < 20) notes.push("ap10 max<20");

  if (spencer?.valuation_row !== false) notes.push("Spencer has row");

  return { pass: notes.length === 0, notes };
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

  const results: Record<string, unknown> = {};
  const scores: { id: string; pass: boolean; notes: string[] }[] = [];

  let baselinePreBoard: ReturnType<typeof boardShapeMetrics> | undefined;
  for (const sc of STAGE3B_MATRIX_SCENARIOS) {
    const byCp: Record<
      string,
      {
        board: ReturnType<typeof boardShapeMetrics>;
        tracked: ReturnType<typeof trackedRows>;
      }
    > = {};
    for (const cp of ENGINE_CHECKPOINTS) {
      const r = runCheckpoint(poolInj, cp, sc.cal);
      byCp[cp] = { board: boardShapeMetrics(r), tracked: trackedRows(r) };
    }
    if (sc.id === "stage3_baseline") {
      baselinePreBoard = byCp.pre_draft?.board;
    }
    const acceptance = passesAcceptance(byCp, { baselinePreBoard });
    scores.push({ id: sc.id, pass: acceptance.pass, notes: acceptance.notes });
    results[sc.id] = { label: sc.label, checkpoints: byCp, acceptance };
  }

  const recommended =
    scores.find((s) => s.id === "integrated_3b" && s.pass)?.id ??
    scores.find((s) => s.pass)?.id ??
    "integrated_3b";

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      { generated_at: new Date().toISOString(), scenarios: results, scores, recommended },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ wrote: OUT, scores, recommended }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
