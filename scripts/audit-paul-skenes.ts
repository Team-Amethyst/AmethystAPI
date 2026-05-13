/**
 * One-off audit: Paul Skenes catalog + standard mixed valuation (explain + debug).
 * Run: MONGO_URI=... pnpm exec ts-node --project tsconfig.scripts.json scripts/audit-paul-skenes.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { playerTokensFromLean } from "../src/lib/fantasyPositioning";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import type { LeanPlayer, ValuedPlayer } from "../src/types/brain";

const SKENES_ID = "694973";

function sortPitchers(pool: LeanPlayer[], rows: ValuedPlayer[]) {
  const byId = new Map(pool.map((p) => [String(p.mlbId ?? p._id), p]));
  const pitchers = rows.filter((r) => {
    const lp = byId.get(r.player_id);
    return lp && isPitcherForBaseline(lp, undefined);
  });
  const tokensFor = (pid: string) => {
    const lp = byId.get(pid);
    return lp ? playerTokensFromLean(lp, undefined) : [];
  };
  const spOnly = (pid: string) => {
    const t = tokensFor(pid);
    return t.includes("SP") && !t.includes("RP");
  };
  const byBaseline = [...pitchers].sort((a, b) => b.baseline_value - a.baseline_value);
  const byAuction = [...pitchers].sort((a, b) => b.auction_value - a.auction_value);
  const spBaseline = byBaseline.filter((r) => spOnly(r.player_id));
  const spAuction = byAuction.filter((r) => spOnly(r.player_id));
  return {
    top25Baseline: byBaseline.slice(0, 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      baseline_value: r.baseline_value,
      auction_value: r.auction_value,
    })),
    top25Auction: byAuction.slice(0, 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      baseline_value: r.baseline_value,
      auction_value: r.auction_value,
    })),
    top25SpBaseline: spBaseline.slice(0, 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      baseline_value: r.baseline_value,
      auction_value: r.auction_value,
    })),
    top25SpAuction: spAuction.slice(0, 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      baseline_value: r.baseline_value,
      auction_value: r.auction_value,
    })),
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let pool: LeanPlayer[];
  try {
    pool = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const skenes = pool.find((p) => String(p.mlbId ?? "") === SKENES_ID || p.name?.includes("Skenes"));
  if (!skenes) {
    console.log(JSON.stringify({ error: "Paul Skenes not found in valuation-eligible catalog", poolSize: pool.length }, null, 2));
    process.exit(1);
  }

  const pid = String(skenes.mlbId ?? skenes._id);
  const pitching = (skenes.projection as Record<string, unknown> | undefined)?.pitching as
    | Record<string, unknown>
    | undefined;

  const catalogPrint = {
    player_id: pid,
    mlbId: skenes.mlbId,
    name: skenes.name,
    team: skenes.team,
    position: skenes.position,
    positions: skenes.positions,
    effective_positions: playerTokensFromLean(skenes, undefined),
    catalog_rank: skenes.catalog_rank,
    catalog_tier: skenes.catalog_tier,
    auction_rank: (skenes as { auction_rank?: unknown }).auction_rank,
    auction_tier: (skenes as { auction_tier?: unknown }).auction_tier,
    baseline_rank: (skenes as { baseline_rank?: unknown }).baseline_rank,
    baseline_tier: (skenes as { baseline_tier?: unknown }).baseline_tier,
    value_field_on_lean: skenes.value,
    projection_pitching: pitching ?? null,
    projection_batting: (skenes.projection as Record<string, unknown> | undefined)?.batting ?? null,
    age: skenes.age,
    depthChartPosition: skenes.depthChartPosition,
    injurySeverity: skenes.injurySeverity,
  };

  const input = {
    ...buildDraftroomStandardValuationInput(),
    explain_valuation_rows: true,
  };

  const wf = executeValuationWorkflow(pool, input, {}, { debugSignals: true });
  if (!wf.ok) {
    console.log(JSON.stringify({ catalog: catalogPrint, workflow_failed: wf.issues }, null, 2));
    process.exit(1);
  }

  const row = wf.response.valuations.find((v) => v.player_id === pid);
  const meta = (
    skenes.projection as { __valuation_meta__?: Record<string, unknown> } | undefined
  )?.__valuation_meta__;

  const rowPrint = row
    ? {
        baseline_value: row.baseline_value,
        auction_value: row.auction_value,
        recommended_bid: row.recommended_bid,
        team_adjusted_value: row.team_adjusted_value,
        replacement_key_used: row.debug_v2?.replacement_key_used ?? row.valuation_explain?.replacement_key_used,
        replacement_value_used: row.debug_v2?.replacement_value_used ?? row.valuation_explain?.replacement_value_used,
        surplus_basis: row.debug_v2?.surplus_basis ?? row.valuation_explain?.surplus_basis,
        inflation_factor: row.inflation_factor,
        baseline_components: row.baseline_components,
        valuation_explain: row.valuation_explain,
        debug_v2: row.debug_v2,
        position_on_row: row.position,
      }
    : null;

  const lists = sortPitchers(pool, wf.response.valuations);
  const skenesRank = {
    among_pitchers_by_baseline:
      [...wf.response.valuations]
        .filter((r) => {
          const lp = pool.find((p) => String(p.mlbId ?? p._id) === r.player_id);
          return lp && isPitcherForBaseline(lp, undefined);
        })
        .sort((a, b) => b.baseline_value - a.baseline_value)
        .findIndex((r) => r.player_id === pid) + 1,
    among_pitchers_by_auction: [...wf.response.valuations]
      .filter((r) => {
        const lp = pool.find((p) => String(p.mlbId ?? p._id) === r.player_id);
        return lp && isPitcherForBaseline(lp, undefined);
      })
      .sort((a, b) => b.auction_value - a.auction_value)
      .findIndex((r) => r.player_id === pid) + 1,
  };

  const replTable = wf.response.replacement_values_by_slot_or_position ?? {};

  console.log(
    JSON.stringify(
      {
        engine_contract_version: wf.response.engine_contract_version,
        valuation_model_version: wf.response.valuation_model_version,
        inflation_factor_response: wf.response.inflation_factor,
        catalog: catalogPrint,
        valuation_meta_projection_hook: meta ?? "(meta only after baseline pass on lean — may be absent pre-pass)",
        skenes_row: rowPrint,
        replacement_values_by_slot_or_position: replTable,
        skenes_rank_among_pitchers: skenesRank,
        top25_pitchers_by_baseline_value: lists.top25Baseline,
        top25_pitchers_by_auction_value: lists.top25Auction,
        top25_sp_only_by_baseline_value: lists.top25SpBaseline,
        top25_sp_only_by_auction_value: lists.top25SpAuction,
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
