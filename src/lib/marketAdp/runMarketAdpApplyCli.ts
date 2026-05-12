/**
 * CLI orchestration for applying market ADP preview JSON to Mongo.
 * Used by `scripts/apply-market-adp-updates.ts`; import in tests with `vi.mock` for Player / mongoose.
 */
import { readFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import Player from "../../models/Player";
import {
  aggregateRowsSkippedInvalid,
  assertMarketAdpApplyPermitted,
  assertPreviewSafeForMarketAdpApply,
  buildMarketAdpApplyPlanFromPreview,
  MARKET_ADP_APPLY_FIELD_KEYS,
  type MarketAdpMongoApplyOperation,
  type MarketAdpPreviewLike,
} from "./applyMarketAdpFromPreview";

const ROOT = path.resolve(__dirname, "..", "..", "..");

const MARKET_ADP_UNSET_DOC = Object.fromEntries(
  MARKET_ADP_APPLY_FIELD_KEYS.map((k) => [k, 1])
) as Record<string, 1>;

type ParsedArgs = {
  previewPath: string;
  apply: boolean;
  clearMissingMarketAdp: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const a = argv.slice(2);
  let previewPath = path.join(ROOT, "tmp/nfbc-data-mongo-preview.json");
  let apply = false;
  let clearMissingMarketAdp = false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--preview" && a[i + 1]) {
      const p = a[++i]!;
      previewPath = path.isAbsolute(p) ? p : path.join(ROOT, p);
    } else if (a[i] === "--apply") {
      apply = true;
    } else if (a[i] === "--clear-missing-market-adp") {
      clearMissingMarketAdp = true;
    }
  }

  return { previewPath, apply, clearMissingMarketAdp };
}

function readPreviewJson(absPath: string): MarketAdpPreviewLike {
  const raw = readFileSync(absPath, "utf8");
  return JSON.parse(raw) as MarketAdpPreviewLike;
}

function resolveMarketAdpSource(
  preview: MarketAdpPreviewLike,
  operations: MarketAdpMongoApplyOperation[]
): string {
  const fromOp = operations[0]?.$set.market_adp_source;
  if (typeof fromOp === "string" && fromOp.trim() !== "") return fromOp.trim();
  const fromAdapter = preview.adapter_display_name;
  if (typeof fromAdapter === "string" && fromAdapter.trim() !== "") return fromAdapter.trim();
  return "NFBC";
}

async function planClearMissing(
  appliedMlbIds: number[],
  marketAdpSource: string
): Promise<{ count: number; sample_mlb_ids: number[] }> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("--clear-missing-market-adp requires MONGO_URI for Mongo inspection");
  }
  await mongoose.connect(uri);
  try {
    const nin = appliedMlbIds.length > 0 ? appliedMlbIds : [-1];
    const filter = {
      mlbId: { $nin: nin, $type: "number" as const, $gt: 0 },
      market_adp_source: marketAdpSource,
      market_adp: { $exists: true, $ne: null },
    };
    const count = await Player.countDocuments(filter);
    const docs = await Player.find(filter)
      .select({ mlbId: 1 })
      .limit(15)
      .lean();
    const sample_mlb_ids = docs
      .map((d) => d.mlbId)
      .filter((m): m is number => typeof m === "number" && Number.isFinite(m) && m > 0);
    return { count, sample_mlb_ids };
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

async function executeApply(
  operations: MarketAdpMongoApplyOperation[],
  opts: { clearMissingMarketAdp: boolean; marketAdpSource: string }
): Promise<{
  modified: number;
  matched: number;
  clear_missing_candidate_count?: number;
  clear_missing_modified?: number;
}> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required for --apply");

  await mongoose.connect(uri);
  try {
    let modified = 0;
    let matched = 0;
    for (const op of operations) {
      const res = await Player.updateOne({ mlbId: op.mlbId }, { $set: op.$set });
      modified += res.modifiedCount ?? 0;
      matched += res.matchedCount ?? 0;
    }

    let clear_missing_candidate_count: number | undefined;
    let clear_missing_modified: number | undefined;
    if (opts.clearMissingMarketAdp) {
      const appliedIds = operations.map((o) => o.mlbId);
      const nin = appliedIds.length > 0 ? appliedIds : [-1];
      const clearFilter = {
        mlbId: { $nin: nin, $type: "number" as const, $gt: 0 },
        market_adp_source: opts.marketAdpSource,
        market_adp: { $exists: true, $ne: null },
      };
      clear_missing_candidate_count = await Player.countDocuments(clearFilter);
      const clearRes = await Player.updateMany(clearFilter, { $unset: MARKET_ADP_UNSET_DOC });
      clear_missing_modified = clearRes.modifiedCount ?? 0;
    }

    return { modified, matched, clear_missing_candidate_count, clear_missing_modified };
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

export async function runMarketAdpApplyCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const preview = readPreviewJson(args.previewPath);
  const plan = buildMarketAdpApplyPlanFromPreview(preview);
  const marketAdpSource = resolveMarketAdpSource(preview, plan.operations);

  assertMarketAdpApplyPermitted({ apply: args.apply, env: process.env });

  const summary = {
    mode: args.apply ? "apply" : "dry_run",
    preview_path: args.previewPath,
    rows_to_update: plan.stats.updates_to_apply,
    rows_skipped_invalid: aggregateRowsSkippedInvalid(plan.stats),
    rows_skipped_ambiguous: plan.ambiguous_vendor_rows_in_preview,
    unmatched_vendor: plan.unmatched_vendor_rows_in_preview,
    unmatched_catalog: plan.unmatched_catalog_rows_in_preview,
    clear_missing_market_adp: args.clearMissingMarketAdp,
    market_adp_source: marketAdpSource,
    sample_operations: plan.operations.slice(0, 5).map((o) => ({
      filter: { mlbId: o.mlbId },
      updateOne: { $set: o.$set },
      match_confidence: o.match_confidence,
    })),
    detail: {
      proposed_total: plan.stats.proposed_total,
      proposals_with_non_market_fields_stripped: plan.stats.proposals_with_non_market_fields_stripped,
      skipped_invalid_player_id: plan.stats.skipped_invalid_player_id,
      skipped_invalid_mlb_id: plan.stats.skipped_invalid_mlb_id,
      skipped_mlb_id_player_id_mismatch: plan.stats.skipped_mlb_id_player_id_mismatch,
      skipped_missing_market_adp: plan.stats.skipped_missing_market_adp,
      skipped_missing_market_adp_source: plan.stats.skipped_missing_market_adp_source,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  console.error("\n--- unmatched_vendor (from preview.matches, unmatched_vendor kind) ---");
  console.error(plan.unmatched_vendor_rows_in_preview);
  console.error("\n--- unmatched_catalog (catalog_unmatched_report length) ---");
  console.error(plan.unmatched_catalog_rows_in_preview);
  console.error("\n--- rows_skipped_ambiguous (must be 0 before apply) ---");
  console.error(plan.ambiguous_vendor_rows_in_preview);

  if (args.clearMissingMarketAdp && !args.apply) {
    const appliedIds = plan.operations.map((o) => o.mlbId);
    const clearPlan = await planClearMissing(appliedIds, marketAdpSource);
    console.error("\n--- clear_missing_market_adp (rows with source still set but not in this ingest) ---");
    console.error(JSON.stringify(clearPlan, null, 2));
    console.error("(dry-run: no $unset executed)");
  }

  if (args.apply) {
    assertPreviewSafeForMarketAdpApply(plan);
    const exec = await executeApply(plan.operations, {
      clearMissingMarketAdp: args.clearMissingMarketAdp,
      marketAdpSource,
    });
    console.log(JSON.stringify({ apply_result: exec }, null, 2));
  }
}
