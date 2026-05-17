/**
 * Investigate auction_value cliff around ranks 28–40 for after_pick_10 vs pre_draft.
 *
 *   npx tsx scripts/after-pick-10-falloff-audit.ts
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import {
  resolveDraftCheckpointFixturePath,
  type EngineCheckpointId,
} from "../src/lib/checkpointSlotReconciliation";
import type { ValuedPlayer, ValuationResponse } from "../src/types/brain";

const OUT = path.resolve(__dirname, "../tmp/after-pick-10-falloff-audit.json");

type RowOut = {
  rank: number;
  player_id: string;
  name: string;
  position: string;
  auction_value: number;
  auction_value_raw: number;
  recommended_bid?: number;
  max_bid?: number;
  team_value?: number;
  edge?: number;
  auction_tier: number;
  baseline_tier: number;
  baseline_value: number;
  surplus_basis?: number;
  auction_curve_tier?: string;
  auction_curve_weight?: number;
  inflation_factor_row?: number;
};

function loadCheckpoint(id: EngineCheckpointId) {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath(id), "utf8"),
  );
  return buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
}

function runValuation(
  pool: ReturnType<typeof scoringAwareBaselinePlayers>,
  input: ReturnType<typeof loadCheckpoint>,
): ValuationResponse {
  const body = {
    ...input,
    inflation_model: "replacement_slots_v2" as const,
    auction_curve_model: "adaptive_surplus_v1" as const,
    explain_valuation_rows: true,
    deterministic: true,
    seed: 42,
  };
  const result = executeValuationWorkflow(pool, body, {}, {});
  if (!result.ok) throw new Error("valuation failed");
  return result.response;
}

function topRows(resp: ValuationResponse, n: number): RowOut[] {
  const sorted = [...resp.valuations].sort(
    (a, b) => b.auction_value - a.auction_value,
  );
  return sorted.slice(0, n).map((v, i) => {
    const ve = v.valuation_explain;
    const dbg = v.debug_v2;
    return {
      rank: i + 1,
      player_id: v.player_id,
      name: v.name,
      position: v.position,
      auction_value: v.auction_value,
      auction_value_raw: v.auction_value,
      recommended_bid: v.recommended_bid,
      max_bid: v.max_bid,
      team_value: v.team_adjusted_value,
      edge: v.edge,
      auction_tier: v.auction_tier,
      baseline_tier: v.baseline_tier,
      baseline_value: v.baseline_value,
      surplus_basis: ve?.surplus_basis ?? dbg?.surplus_basis,
      auction_curve_tier: ve?.auction_curve_tier,
      auction_curve_weight: ve?.auction_curve_weight,
      inflation_factor_row: ve?.inflation_factor,
    };
  });
}

function shelfAnalysis(rows: RowOut[]) {
  const byAv = new Map<number, number>();
  for (const r of rows) {
    const k = Math.round(r.auction_value * 100) / 100;
    byAv.set(k, (byAv.get(k) ?? 0) + 1);
  }
  const shelves = [...byAv.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[0] - a[0]);
  let cliff: { fromRank: number; toRank: number; drop: number } | null = null;
  for (let i = 1; i < rows.length; i++) {
    const drop = rows[i - 1]!.auction_value - rows[i]!.auction_value;
    if (drop >= 8) {
      cliff = {
        fromRank: rows[i - 1]!.rank,
        toRank: rows[i]!.rank,
        drop,
      };
      break;
    }
  }
  return { shelves, cliff };
}

function draftedAuctionIds(input: ReturnType<typeof loadCheckpoint>): string[] {
  return input.drafted_players
    .filter((p) => !p.is_keeper)
    .map((p) => String(p.player_id));
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
  const preInput = loadCheckpoint("pre_draft");
  const afterInput = loadCheckpoint("after_pick_10");

  const preResp = runValuation(
    applyInjuryOverridesToPool(
      valuationPool,
      preInput.injury_overrides,
    ),
    preInput,
  );
  const afterResp = runValuation(
    applyInjuryOverridesToPool(
      valuationPool,
      afterInput.injury_overrides,
    ),
    afterInput,
  );

  const preTop60 = topRows(preResp, 60);
  const afterTop60 = topRows(afterResp, 60);

  const preIds = new Set(preTop60.map((r) => r.player_id));
  const afterIds = new Set(afterTop60.map((r) => r.player_id));
  const removedFromTop60 = preTop60.filter((r) => !afterIds.has(r.player_id));
  const pickedIds = draftedAuctionIds(afterInput);

  const meta = (resp: ValuationResponse) => ({
    auction_curve_model: resp.auction_curve_model,
    auction_curve_reason: resp.auction_curve_reason,
    internal_allocation_mode: resp.internal_allocation_mode,
    curve_inputs: resp.curve_inputs,
    selected_weights: resp.selected_weights,
    curve_guardrails: resp.curve_guardrails,
    curve_guardrails_applied: resp.curve_guardrails_applied,
    total_budget_remaining: resp.total_budget_remaining,
    remaining_slots: resp.remaining_slots,
    inflation_factor: resp.inflation_factor,
    market_pressure: resp.market_pressure,
    surplus_cash: resp.curve_inputs?.allocatable_surplus_dollars,
    total_surplus_mass: resp.curve_inputs?.total_surplus_mass,
  });

  const report = {
    checkpoint_paths: {
      pre_draft: resolveDraftCheckpointFixturePath("pre_draft"),
      after_pick_10: resolveDraftCheckpointFixturePath("after_pick_10"),
    },
    auction_picks_in_after_fixture: pickedIds,
    pre_draft: {
      metadata: meta(preResp),
      top60: preTop60,
      ranks_25_45: preTop60.filter((r) => r.rank >= 25 && r.rank <= 45),
      shelf: shelfAnalysis(preTop60),
    },
    after_pick_10: {
      metadata: meta(afterResp),
      top60: afterTop60,
      ranks_25_45: afterTop60.filter((r) => r.rank >= 25 && r.rank <= 45),
      shelf: shelfAnalysis(afterTop60),
    },
    comparison: {
      removed_from_pre_top60_after_10_picks: removedFromTop60,
      ui_rounding_note:
        "Research displays Math.round(auction_value) via formatCurrencyWhole",
    },
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log("Wrote", OUT);

  console.log("\n--- after_pick_10 metadata ---");
  console.log(JSON.stringify(report.after_pick_10.metadata, null, 2));
  console.log("\n--- after_pick_10 ranks 25-45 ---");
  for (const r of report.after_pick_10.ranks_25_45) {
    console.log(
      `${r.rank}\t${r.auction_value}\tsb=${r.surplus_basis ?? "?"}\tcurve=${r.auction_curve_tier ?? "?"}\tav_tier=${r.auction_tier}\tbl_tier=${r.baseline_tier}\t${r.name}`,
    );
  }
  console.log("\n--- shelf / cliff ---");
  console.log(JSON.stringify(report.after_pick_10.shelf, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
