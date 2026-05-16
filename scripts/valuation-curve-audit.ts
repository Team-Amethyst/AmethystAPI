/**
 * Valuation curve audit across checkpoints and curve models.
 *
 *   pnpm valuation-curve-audit
 *
 * Requires MONGO_URI. Writes tmp/valuation-curve-audit.json
 */
import "dotenv/config";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import {
  buildNormalizedFromFlat,
  buildNormalizedFromNested,
} from "../src/lib/valuationRequestNormalization";
import {
  flatValuationBodySchema,
  nestedValuationBodySchema,
} from "../src/lib/valuationRequestSchemas";
import {
  buildRosteredPlayersForSlotEngine,
  isReserveRosterSlotForEngine,
} from "../src/lib/rosteredPlayersForSlots";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { leagueSlotCapacity } from "../src/services/teamAdjustedValue";
import { sumAuctionValueForDraftablePool } from "../src/lib/rosterUniverseValuationCalibration";
import type { AuctionCurveModel } from "../src/services/auctionCurveModel";
import type {
  LeanPlayer,
  NormalizedValuationInput,
  ValuationResponse,
  ValuedPlayer,
} from "../src/types/brain";
import { getPlayerId } from "../src/lib/playerId";
import {
  DRAFT_CHECKPOINT_FILENAME,
  reconcileCheckpointSlotDemand,
  summarizeReconciliationLine,
  type EngineCheckpointId,
} from "../src/lib/checkpointSlotReconciliation";

const ROOT = path.resolve(__dirname, "..");
/** Canonical checkpoints — must match AmethystDraft `engineCheckpointCatalog.ts`. */
const DRAFT_CHECKPOINTS_DIR = path.resolve(
  ROOT,
  "../AmethystDraft/apps/api/test-fixtures/player-api/checkpoints"
);
const OUT = path.join(ROOT, "tmp", "valuation-curve-audit.json");
const TOP_N = 50;
const TOP_25 = 25;
const MODELS: AuctionCurveModel[] = [
  "linear_v1",
  "tiered_surplus_v1",
  "adaptive_surplus_v1",
];

const CHECKPOINT_ORDER = [
  "fresh_9_team_no_keepers",
  "pre_draft",
  "after_pick_10",
  "after_pick_50",
  "after_pick_100",
  "after_pick_130",
  "finished_league",
];

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function countPool(input: NormalizedValuationInput) {
  const slotEngine = buildRosteredPlayersForSlotEngine(input);
  let minTaxi = 0;
  const slotIds = new Set(slotEngine.map((p) => p.player_id));
  for (const d of input.drafted_players) {
    if (isReserveRosterSlotForEngine(d.roster_slot) && !slotIds.has(d.player_id)) {
      minTaxi++;
    }
  }
  if (input.pre_draft_rosters) {
    for (const rows of Object.values(input.pre_draft_rosters)) {
      for (const r of rows) {
        const rec = r as { roster_slot?: string; player_id?: string };
        if (
          rec.player_id &&
          isReserveRosterSlotForEngine(rec.roster_slot) &&
          !slotIds.has(rec.player_id)
        ) {
          minTaxi++;
        }
      }
    }
  }
  const keepers = slotEngine.filter((p) => p.is_keeper).length;
  const auctionDrafted = input.drafted_players.filter(
    (p) => !isReserveRosterSlotForEngine(p.roster_slot)
  ).length;
  return {
    slot_engine_rostered_count: slotEngine.length,
    keeper_count: keepers,
    drafted_auction_count: auctionDrafted,
    min_taxi_pool_count: minTaxi,
  };
}

function rowDetail(
  r: ValuedPlayer,
  poolById: Map<string, LeanPlayer>,
  resp: ValuationResponse
) {
  const lp = poolById.get(r.player_id);
  const bc = r.baseline_components ?? {};
  const ex = (r.valuation_explain ?? {}) as Record<string, unknown>;
  const bcRec = bc as Record<string, unknown>;
  const curveTier =
    typeof ex.auction_curve_tier === "string" ? ex.auction_curve_tier : null;
  const curveWeight = num(ex.auction_curve_weight);
  return {
    rank: 0,
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    baseline_value: r.baseline_value,
    surplus_basis: num(ex.surplus_basis) || num(r.debug_v2?.surplus_basis),
    auction_value: r.auction_value,
    recommended_bid: r.recommended_bid ?? null,
    replacement_slot:
      typeof ex.replacement_key_used === "string" ? ex.replacement_key_used : null,
    replacement_value_used: num(ex.replacement_value_used),
    projection_component: num(bcRec.projection_component),
    scarcity_component: num(bcRec.scarcity_component),
    curve_tier: curveTier,
    curve_weight_applied: curveWeight > 0 ? curveWeight : null,
    curve_debug_note: resp.auction_curve_reason ?? null,
    catalog_rank: lp?.catalog_rank ?? null,
  };
}

function summaryStats(
  rows: ValuedPlayer[],
  market: { remaining_active_slots: number; min_bid: number }
) {
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
  const sumAuctionValues = rows.reduce((s, r) => s + r.auction_value, 0);
  const minReserve = market.remaining_active_slots * market.min_bid;
  let maxRecommendedBid = 0;
  for (const r of rows) {
    const rb = r.recommended_bid ?? 0;
    if (rb > maxRecommendedBid) maxRecommendedBid = rb;
  }
  const top1 = positive[0] ?? 0;
  const top10 = positive[9] ?? positive[positive.length - 1] ?? 0;
  const top25 = positive[24] ?? positive[positive.length - 1] ?? 0;
  return {
    top_1_auction_value: top1,
    top_5_avg: avg(positive.slice(0, 5)),
    top_10_avg: avg(positive.slice(0, 10)),
    top_25_avg: avg(positive.slice(0, 25)),
    top_50_avg: avg(positive.slice(0, 50)),
    top_10_spread: top1 - top10,
    top_25_spread: top1 - top25,
    median_positive_auction_value: median,
    sum_displayed_auction_values: sumAuctionValues,
    max_recommended_bid: maxRecommendedBid,
    minimum_reserve_dollars: minReserve,
  };
}

function surplusConservationDelta(rows: ValuedPlayer[], minBid: number, surplusCash: number) {
  let sum = 0;
  for (const r of rows) {
    sum += Math.max(0, r.auction_value - minBid);
  }
  return surplusCash - sum;
}

function runCurve(
  scenarioLabel: string,
  auctionCurveModel: AuctionCurveModel,
  input: NormalizedValuationInput,
  pool: LeanPlayer[]
) {
  const body = {
    ...input,
    explain_valuation_rows: true,
    inflation_model: "replacement_slots_v2" as const,
    auction_curve_model: auctionCurveModel,
    deterministic: true,
    seed: 42,
  };
  const result = executeValuationWorkflow(pool, body, {}, {});
  if (!result.ok) {
    throw new Error(`${scenarioLabel}/${auctionCurveModel}: workflow failed`);
  }
  const resp = result.response;
  const poolById = new Map(pool.map((p) => [getPlayerId(p), p]));
  const sorted = [...resp.valuations].sort((a, b) => b.auction_value - a.auction_value);
  const cap = leagueSlotCapacity(input.roster_slots, input.num_teams);
  const remaining = resp.remaining_slots ?? 0;
  const minBid = resp.min_bid ?? 1;
  const minReserve = remaining * minBid;
  const surplusCash = resp.surplus_cash ?? 0;
  const poolCounts = countPool(body);

  const market = {
    active_slot_capacity: cap,
    active_rostered_count: poolCounts.slot_engine_rostered_count,
    remaining_active_slots: remaining,
    open_slot_ratio: cap > 0 ? remaining / cap : 0,
    keeper_count: poolCounts.keeper_count,
    drafted_auction_count: poolCounts.drafted_auction_count,
    min_taxi_pool_count: poolCounts.min_taxi_pool_count,
    remaining_auction_dollars: surplusCash + minReserve,
    minimum_reserve_dollars: minReserve,
    allocatable_surplus_dollars: surplusCash,
    total_surplus_mass: resp.total_surplus_mass ?? 0,
    inflation_raw: resp.inflation_raw,
    surplus_allocation_factor: resp.inflation_factor,
    applied_curve_model: resp.auction_curve_model ?? auctionCurveModel,
    auction_curve_reason: resp.auction_curve_reason ?? null,
    internal_allocation_mode: resp.internal_allocation_mode ?? null,
    selected_weights: resp.selected_weights ?? null,
    top10_linear_spread: resp.top10_linear_spread ?? null,
    curve_inputs: resp.curve_inputs ?? null,
    curve_guardrails: resp.curve_guardrails ?? null,
    curve_guardrails_applied: resp.curve_guardrails_applied ?? null,
  };

  const draftableSum = sumAuctionValueForDraftablePool(resp.valuations, resp);
  const summary = {
    ...summaryStats(resp.valuations, {
      remaining_active_slots: remaining,
      min_bid: minBid,
    }),
    sum_auction_value_draftable_pool: draftableSum.sum,
    draftable_sum_mode: draftableSum.mode,
    surplus_conservation_delta: surplusConservationDelta(
      resp.valuations,
      minBid,
      surplusCash
    ),
    remaining_auction_dollars: market.remaining_auction_dollars,
    allocatable_surplus_dollars: surplusCash,
  };

  const top50 = sorted.slice(0, TOP_N).map((r, i) => ({
    ...rowDetail(r, poolById, resp),
    rank: i + 1,
  }));
  const top25 = top50.slice(0, TOP_25);

  return {
    auction_curve_model: auctionCurveModel,
    market,
    summary,
    top_50: top50,
    top_25: top25,
  };
}

function loadDraftCheckpoint(
  checkpointId: EngineCheckpointId
): { input: NormalizedValuationInput; fixture_path: string } {
  const file = DRAFT_CHECKPOINT_FILENAME[checkpointId];
  const fixture_path = path.join(DRAFT_CHECKPOINTS_DIR, file);
  const raw = JSON.parse(readFileSync(fixture_path, "utf8")) as Record<string, unknown>;
  if (
    typeof raw === "object" &&
    raw != null &&
    "league" in raw &&
    "draft_state" in raw
  ) {
    return {
      fixture_path,
      input: buildNormalizedFromNested(nestedValuationBodySchema.parse(raw)),
    };
  }
  return {
    fixture_path,
    input: buildNormalizedFromFlat(flatValuationBodySchema.parse(raw)),
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let catalog: LeanPlayer[];
  try {
    catalog = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const keeperTemplate = loadDraftCheckpoint("pre_draft").input;
  const freshInput = buildDraftroomStandardValuationInput({
    num_teams: keeperTemplate.num_teams,
    total_budget: keeperTemplate.total_budget,
    roster_slots: keeperTemplate.roster_slots,
    scoring_categories: keeperTemplate.scoring_categories,
    league_scope: keeperTemplate.league_scope,
    scoring_format: keeperTemplate.scoring_format,
    drafted_players: [],
    pre_draft_rosters: undefined,
    minors: undefined,
    taxi: undefined,
  });

  const valuationPool = filterValuationUniverse(catalog, {
    leagueScope: keeperTemplate.league_scope,
  });
  const poolWithInjury = applyInjuryOverridesToPool(
    valuationPool,
    keeperTemplate.injury_overrides
  );
  const positionOverrides = positionOverridesFromRequest(
    keeperTemplate.position_overrides
  );
  const basePlayers = scoringAwareBaselinePlayers(
    poolWithInjury,
    keeperTemplate.scoring_format,
    keeperTemplate.scoring_categories,
    keeperTemplate.roster_slots,
    positionOverrides
  );

  const scenarios: Array<{
    label: string;
    checkpoint_reconciliation: ReturnType<typeof reconcileCheckpointSlotDemand>;
    curves: Record<string, ReturnType<typeof runCurve>>;
  }> = [];

  const scenarioInputs: Array<{
    label: string;
    checkpoint_id?: EngineCheckpointId;
    input: NormalizedValuationInput;
    fixture_path?: string;
  }> = [{ label: "fresh_9_team_no_keepers", input: freshInput }];

  for (const checkpointId of [
    "pre_draft",
    "after_pick_10",
    "after_pick_50",
    "after_pick_100",
    "after_pick_130",
    "finished_league",
  ] as const) {
    const loaded = loadDraftCheckpoint(checkpointId);
    scenarioInputs.push({
      label: checkpointId === "pre_draft" ? "pre_draft_keeper" : checkpointId,
      checkpoint_id: checkpointId,
      input: loaded.input,
      fixture_path: loaded.fixture_path,
    });
  }

  for (const { label, input, checkpoint_id, fixture_path } of scenarioInputs) {
    const curves: Record<string, ReturnType<typeof runCurve>> = {};
    for (const model of MODELS) {
      curves[model] = runCurve(label, model, input, basePlayers);
    }
    const adaptiveRemaining = curves.adaptive_surplus_v1?.market.remaining_active_slots;
    const reconciliation = reconcileCheckpointSlotDemand(input, {
      checkpoint_id: checkpoint_id ?? label,
      fixture_path,
      engine_remaining_slots: adaptiveRemaining,
    });
    scenarios.push({ label, checkpoint_reconciliation: reconciliation, curves });
  }

  const out = {
    generated_at: new Date().toISOString(),
    checkpoint_order: CHECKPOINT_ORDER,
    fixture_source: DRAFT_CHECKPOINTS_DIR,
    fixture_filename_map: DRAFT_CHECKPOINT_FILENAME,
    models: MODELS,
    scenarios,
    notes: [
      "Checkpoints load from AmethystDraft nested fixtures (after_10.json etc.), not AmethystAPI after_pick_10.json flat legacy files (198-slot template).",
      "MIN/TAXI excluded from active slot demand; included in pool removal when assigned.",
      "remaining_active_slots_engine comes from replacement_slots_v2 greedy demand; when active_rostered > capacity, engine remaining floors at 0 while arithmetic (capacity − rostered) may be negative.",
      "Keeper count can drop below pre_draft_rosters when a keeper is re-acquired in draft_state (dedupe: auction row wins, is_keeper may be false).",
      "finished_league draft_state = 133 auction picks (full Draft sheet), not Final Roster embed.",
      "adaptive_surplus_v1 is production default.",
      "linear_v1 does not conserve allocatable surplus_cash.",
      "tiered/adaptive conserve surplus within rounding when using tier allocation.",
    ],
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT}\n`);

  console.log("--- checkpoint slot reconciliation (canonical Draft fixtures) ---\n");
  for (const s of scenarios) {
    const r = s.checkpoint_reconciliation;
    console.log(summarizeReconciliationLine(r));
    if (r.notes.length) {
      for (const n of r.notes) console.log(`  note: ${n}`);
    }
  }
  console.log("\n--- valuation curves ---\n");

  for (const s of scenarios) {
    console.log(`=== ${s.label} ===`);
    const r = s.checkpoint_reconciliation;
    console.log(
      `reconcile: cap=${r.roster_slot_capacity} rostered=${r.active_rostered_slot_engine_count} (keepers=${r.active_rostered_keeper_count} + auction=${r.active_drafted_auction_count}) arithmetic_remaining=${r.remaining_active_slots_arithmetic}`
    );
    const adaptive = s.curves.adaptive_surplus_v1!;
    console.log(
      `engine remaining/capacity=${adaptive.market.remaining_active_slots}/${adaptive.market.active_slot_capacity} mode=${adaptive.market.internal_allocation_mode}`
    );
    for (const model of MODELS) {
      const c = s.curves[model]!;
      const sum = c.summary;
      console.log(
        `  ${model}: top1=$${sum.top_1_auction_value.toFixed(2)} top10avg=$${sum.top_10_avg.toFixed(2)} spread10=$${sum.top_10_spread.toFixed(2)} maxRec=$${sum.max_recommended_bid.toFixed(2)} conserveΔ=${sum.surplus_conservation_delta.toFixed(2)}`
      );
    }
    console.log(
      `  adaptive reason: ${adaptive.market.auction_curve_reason} linearSpread=${adaptive.market.top10_linear_spread}`
    );
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
