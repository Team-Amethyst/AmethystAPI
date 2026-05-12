/**
 * Split auction_value tail metrics: full pool vs replacement_slots_v2 draftable ID set.
 *
 *   MONGO_URI=... npx ts-node --project tsconfig.scripts.json scripts/report-draftable-tail-distributions.ts
 *
 * Writes tmp/draftable-tail-distributions.json
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import type { LeanPlayer, ValuedPlayer } from "../src/types/brain";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import {
  buildDraftroomStandardValuationInput,
} from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { getPlayerId } from "../src/lib/playerId";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "draftable-tail-distributions.json");

function av(v: ValuedPlayer): number {
  const x = v.auction_value;
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

type ExclusiveBuckets = {
  exactly_1: number;
  /** (1, 1.05] */
  gt1_through_105: number;
  /** (1.05, 3] */
  gt105_through_3: number;
  gt3_through_5: number;
  gt5_through_10: number;
  gt10_through_20: number;
  gt20: number;
};

function emptyExclusive(): ExclusiveBuckets {
  return {
    exactly_1: 0,
    gt1_through_105: 0,
    gt105_through_3: 0,
    gt3_through_5: 0,
    gt5_through_10: 0,
    gt10_through_20: 0,
    gt20: 0,
  };
}

function top25ByAuction(rows: ValuedPlayer[]): {
  player_id: string;
  name: string;
  position: string;
  auction_value: number;
}[] {
  return [...rows]
    .sort((a, b) => av(b) - av(a))
    .slice(0, 25)
    .map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      auction_value: parseFloat(av(r).toFixed(2)),
    }));
}

function accumulate(rows: ValuedPlayer[]): {
  exclusive: ExclusiveBuckets;
  near105Share: number;
  eq1Share: number;
  count_le_105: number;
  count_eq_1: number;
} {
  const ex = emptyExclusive();
  let le105 = 0;
  let eq1 = 0;
  for (const r of rows) {
    const a = av(r);
    const isEq1 = Math.abs(a - 1) < 0.001;
    if (isEq1) {
      eq1++;
      ex.exactly_1++;
    }
    if (a <= 1.05) le105++;

    if (isEq1) continue;
    if (a <= 1.05) ex.gt1_through_105++;
    else if (a <= 3) ex.gt105_through_3++;
    else if (a <= 5) ex.gt3_through_5++;
    else if (a <= 10) ex.gt5_through_10++;
    else if (a <= 20) ex.gt10_through_20++;
    else ex.gt20++;
  }
  const n = rows.length || 1;
  return {
    exclusive: ex,
    near105Share: le105 / n,
    eq1Share: eq1 / n,
    count_le_105: le105,
    count_eq_1: eq1,
  };
}

/** Readable bucket counts aligned with triage asks (intervals are half-open on the left where noted). */
function bucketSummary(ex: ExclusiveBuckets): {
  exactly_1: number;
  /** (1, 3] */
  gt1_through_3: number;
  /** (3, 5] */
  gt3_through_5: number;
  /** (5, 10] */
  gt5_through_10: number;
  /** (10, 20] */
  gt10_through_20: number;
  /** > 20 */
  gt20: number;
} {
  return {
    exactly_1: ex.exactly_1,
    gt1_through_3: ex.gt1_through_105 + ex.gt105_through_3,
    gt3_through_5: ex.gt3_through_5,
    gt5_through_10: ex.gt5_through_10,
    gt10_through_20: ex.gt10_through_20,
    gt20: ex.gt20,
  };
}

function hpSplit(
  rows: ValuedPlayer[],
  poolById: Map<string, LeanPlayer>,
  ov: ReturnType<typeof positionOverridesFromRequest>
): { hitter: number; pitcher: number; unknown: number } {
  let hitter = 0,
    pitcher = 0,
    unk = 0;
  for (const r of rows) {
    const lp = poolById.get(r.player_id);
    if (!lp) {
      unk++;
      continue;
    }
    if (isPitcherForBaseline(lp, ov)) pitcher++;
    else hitter++;
  }
  return { hitter, pitcher, unknown: unk };
}

function posSplit(rows: ValuedPlayer[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) {
    const tok = (r.position ?? "UNK").trim().split(/[,/ ]+/)[0] ?? "UNK";
    const k = tok.toUpperCase() || "UNK";
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri);
  let pool: LeanPlayer[];
  try {
    pool = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const input = buildDraftroomStandardValuationInput({
    deterministic: true,
    seed: 42,
    inflation_model: "replacement_slots_v2",
  });
  const wf = executeValuationWorkflow(pool, input, {});
  if (!wf.ok || !wf.response) {
    throw new Error(wf.ok === false ? wf.issues.join("; ") : "no response");
  }

  const res = wf.response;
  const rows = res.valuations;
  const dps = res.draftable_pool_size;
  const ids = res.draftable_player_ids ?? [];
  if (dps != null && ids.length !== dps) {
    throw new Error(
      `draftable_player_ids length ${ids.length} !== draftable_pool_size ${dps}`
    );
  }

  const draftSet = new Set(ids);
  const draftableRows = rows.filter((r) => draftSet.has(r.player_id));
  const outsideRows = rows.filter((r) => !draftSet.has(r.player_id));

  const poolById = new Map(pool.map((p) => [getPlayerId(p), p]));
  const ov = positionOverridesFromRequest(input.position_overrides);

  const accAll = accumulate(rows);
  const accDraft = accumulate(draftableRows);
  const accOut = accumulate(outsideRows);

  const report = {
    generated_at: new Date().toISOString(),
    scenario: "standard_12_mixed (buildDraftroomStandardValuationInput)",
    valuation_rows: rows.length,
    draftable_pool_size: dps,
    draftable_ids_count: ids.length,
    remaining_slots: res.remaining_slots,
    groups: {
      all_rows: {
        count: rows.length,
        ...accAll,
        bucket_counts_display: bucketSummary(accAll.exclusive),
        top_25_auction_value: top25ByAuction(rows),
        hitter_pitcher: hpSplit(rows, poolById, ov),
        position_split: posSplit(rows),
      },
      draftable_greedy_fill: {
        count: draftableRows.length,
        ...accDraft,
        bucket_counts_display: bucketSummary(accDraft.exclusive),
        top_25_auction_value: top25ByAuction(draftableRows),
        hitter_pitcher: hpSplit(draftableRows, poolById, ov),
        position_split: posSplit(draftableRows),
      },
      outside_draftable_set: {
        count: outsideRows.length,
        ...accOut,
        bucket_counts_display: bucketSummary(accOut.exclusive),
        top_25_auction_value: top25ByAuction(outsideRows),
        hitter_pitcher: hpSplit(outsideRows, poolById, ov),
        position_split: posSplit(outsideRows),
      },
    },
    compare_near_1: {
      pct_le_105_draftable: accDraft.near105Share,
      pct_le_105_outside: accOut.near105Share,
      pct_eq_1_draftable: accDraft.eq1Share,
      pct_eq_1_outside: accOut.eq1Share,
      interpretation_hint:
        "If near-$1 concentrates outside the greedy draftable set, the global 77% tail is largely non-draftable replacement depth, not broken star pricing.",
    },
    notes: {
      draftable_definition:
        "Player IDs that reduced remaining league slot demand in replacement_slots_v2 greedy undrafted pass (engine internal; not top-N by auction_value).",
      buckets:
        "exclusive: exactly_1; (1,1.05]; (1.05,3]; (3,5]; (5,10]; (10,20]; >20. near105Share = fraction with AV<=1.05. bucket_counts_display merges (1,1.05]+(1.05,3] as gt1_through_3.",
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(`Wrote ${OUT}`);
  console.log(
    JSON.stringify(
      {
        near105_all: report.groups.all_rows.near105Share,
        near105_draftable: report.groups.draftable_greedy_fill.near105Share,
        near105_outside: report.groups.outside_draftable_set.near105Share,
        draftable_count: report.groups.draftable_greedy_fill.count,
        outside_count: report.groups.outside_draftable_set.count,
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
