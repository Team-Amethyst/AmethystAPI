/**
 * Top-50 valuation curve audit for pre_draft vs fresh open league.
 *
 *   pnpm valuation-curve-audit
 *
 * Requires MONGO_URI. Writes tmp/valuation-curve-audit.json
 */
import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { buildRosteredPlayersForSlotEngine } from "../src/lib/rosteredPlayersForSlots";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { leagueSlotCapacity } from "../src/services/teamAdjustedValue";
import type { LeanPlayer, NormalizedValuationInput, ValuedPlayer } from "../src/types/brain";
import { getPlayerId } from "../src/lib/playerId";

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATHS = [
  path.resolve(ROOT, "../AmethystDraft/apps/api/test-fixtures/player-api/checkpoints/pre_draft.json"),
  path.join(ROOT, "test-fixtures/player-api/checkpoints/pre_draft.json"),
];
const OUT = path.join(ROOT, "tmp", "valuation-curve-audit.json");
const TOP_N = 50;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function rowDetail(r: ValuedPlayer, poolById: Map<string, LeanPlayer>) {
  const lp = poolById.get(r.player_id);
  const bc = r.baseline_components ?? {};
  const ex = (r.valuation_explain ?? {}) as Record<string, unknown>;
  const bcRec = bc as Record<string, unknown>;
  return {
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    baseline_value: r.baseline_value,
    surplus_basis: num(ex.surplus_basis) || num(r.debug_v2?.surplus_basis),
    auction_value: r.auction_value,
    recommended_bid: r.recommended_bid,
    replacement_slot:
      typeof ex.replacement_key_used === "string" ? ex.replacement_key_used : null,
    replacement_value_used: num(ex.replacement_value_used),
    projection_component: num(bcRec.projection_component),
    scarcity_component: num(bcRec.scarcity_component),
    inflation_factor_row: r.inflation_factor,
    inflation_adjustment: r.inflation_adjustment,
  };
}

function summaryStats(rows: ValuedPlayer[]) {
  const positive = rows
    .filter((r) => r.auction_value > 1)
    .map((r) => r.auction_value)
    .sort((a, b) => b - a);
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
  const median =
    positive.length === 0
      ? 0
      : positive.length % 2 === 1
        ? positive[Math.floor(positive.length / 2)]!
        : (positive[positive.length / 2 - 1]! + positive[positive.length / 2]!) / 2;
  const totalAuction = rows.reduce((s, r) => s + r.auction_value, 0);
  return {
    top_1_auction_value: positive[0] ?? 0,
    top_5_avg: avg(positive.slice(0, 5)),
    top_10_avg: avg(positive.slice(0, 10)),
    top_25_avg: avg(positive.slice(0, 25)),
    top_50_avg: avg(positive.slice(0, 50)),
    median_positive_auction_value: median,
    replacement_level_auction_value: positive[positive.length - 1] ?? 0,
    total_auction_value_allocated: totalAuction,
    undrafted_row_count: rows.length,
  };
}

function runScenario(
  label: string,
  input: NormalizedValuationInput,
  pool: LeanPlayer[]
) {
  const body = {
    ...input,
    explain_valuation_rows: true,
    inflation_model: "replacement_slots_v2" as const,
    deterministic: true,
    seed: 42,
  };
  const result = executeValuationWorkflow(pool, body, {}, {});
  if (!result.ok) {
    throw new Error(`${label}: valuation workflow failed`);
  }
  const resp = result.response;
  const poolById = new Map(pool.map((p) => [getPlayerId(p), p]));
  const sorted = [...resp.valuations].sort((a, b) => b.auction_value - a.auction_value);
  const top = sorted.slice(0, TOP_N).map((r, i) => ({
    rank: i + 1,
    ...rowDetail(r, poolById),
  }));
  const cap = leagueSlotCapacity(input.roster_slots, input.num_teams);
  const remaining = resp.remaining_slots ?? 0;
  const minBid = resp.min_bid ?? 1;
  const minReserve = remaining * minBid;
  const surplusCash = resp.surplus_cash ?? 0;
  const rostered = buildRosteredPlayersForSlotEngine(body);

  return {
    label,
    market: {
      remaining_active_slots: remaining,
      league_active_slot_capacity: cap,
      open_slot_ratio: cap > 0 ? remaining / cap : 0,
      remaining_auction_dollars: surplusCash + minReserve,
      minimum_reserve_dollars: minReserve,
      allocatable_surplus_dollars: surplusCash,
      surplus_allocation_factor: resp.inflation_factor,
      inflation_raw: resp.inflation_raw,
      inflation_bounded_by: resp.inflation_bounded_by,
      total_surplus_mass: resp.total_surplus_mass,
      draftable_pool_size: resp.draftable_pool_size,
      slot_engine_rostered_count: rostered.length,
    },
    top_50: top,
    summary: summaryStats(resp.valuations),
    baseline_spread_top_10: top.slice(0, 10).map((r) => r.baseline_value),
    surplus_spread_top_10: top.slice(0, 10).map((r) => r.surplus_basis),
  };
}

async function main(): Promise<void> {
  const fixturePath = FIXTURE_PATHS.find((p) => {
    try {
      readFileSync(p, "utf8");
      return true;
    } catch {
      return false;
    }
  });
  if (!fixturePath) throw new Error("pre_draft.json not found");

  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  const keeperInput = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
  keeperInput.explain_valuation_rows = true;

  const freshInput = buildDraftroomStandardValuationInput({
    num_teams: keeperInput.num_teams,
    total_budget: keeperInput.total_budget,
    roster_slots: keeperInput.roster_slots,
    scoring_categories: keeperInput.scoring_categories,
    league_scope: keeperInput.league_scope,
    scoring_format: keeperInput.scoring_format,
    drafted_players: [],
    pre_draft_rosters: undefined,
    minors: undefined,
    taxi: undefined,
  });

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let catalog: LeanPlayer[];
  try {
    catalog = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const valuationPool = filterValuationUniverse(catalog, {
    leagueScope: keeperInput.league_scope,
  });
  const poolWithInjury = applyInjuryOverridesToPool(
    valuationPool,
    keeperInput.injury_overrides
  );
  const positionOverrides = positionOverridesFromRequest(keeperInput.position_overrides);
  const basePlayers = scoringAwareBaselinePlayers(
    poolWithInjury,
    keeperInput.scoring_format,
    keeperInput.scoring_categories,
    keeperInput.roster_slots,
    positionOverrides
  );

  const preDraft = runScenario("pre_draft_keeper", keeperInput, basePlayers);
  const fresh = runScenario("fresh_9_team_no_keepers", freshInput, basePlayers);

  const out = {
    generated_at: new Date().toISOString(),
    scenarios: [preDraft, fresh],
    notes: [
      "MIN/TAXI excluded from slot engine; pool removal unchanged.",
      "Flat top auction band often tracks flat baseline/surplus_basis at the top of the catalog.",
    ],
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT}\n`);
  for (const s of out.scenarios) {
    console.log(`=== ${s.label} ===`);
    console.log(
      `slots open=${s.market.remaining_active_slots}/${s.market.league_active_slot_capacity} factor=${s.market.surplus_allocation_factor} raw=${s.market.inflation_raw} bounded=${s.market.inflation_bounded_by}`
    );
    console.log(
      `surplus_cash=${s.market.allocatable_surplus_dollars} mass=${s.market.total_surplus_mass}`
    );
    console.log(
      `top1=$${s.summary.top_1_auction_value} top5avg=$${s.summary.top_5_avg.toFixed(1)} top10avg=$${s.summary.top_10_avg.toFixed(1)}`
    );
    console.log(`top10 baseline: ${s.baseline_spread_top_10.map((v) => v?.toFixed?.(1) ?? v).join(", ")}`);
    console.log(`top3 auction: ${s.top_50.slice(0, 3).map((r) => `${r.name} $${r.auction_value}`).join(", ")}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
