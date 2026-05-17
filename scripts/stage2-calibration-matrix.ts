/**
 * Stage 2 hybrid/saturated-slot calibration matrix (pre_draft).
 *   npx tsx scripts/stage2-calibration-matrix.ts [out.json]
 */
import { config } from "dotenv";
config({ quiet: true });
import { readFileSync, writeFileSync } from "fs";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { getPlayerId } from "../src/lib/playerId";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";
import { buildRosteredPlayersForSlotEngine } from "../src/lib/rosteredPlayersForSlots";
import { computeRemainingLeagueRosterSlots } from "../src/lib/remainingLeagueRosterSlots";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { calculateInflation } from "../src/services/inflationEngine";
import { computeBudgetRemaining } from "../src/services/inflationModel";
import { computeReplacementSlotsV2 } from "../src/services/replacementSlotsV2";
import {
  DEFAULT_HYBRID_SURPLUS_CALIBRATION,
  STAGE1_HYBRID_SURPLUS_CALIBRATION,
  type HybridSurplusCalibration,
} from "../src/services/replacementSlotsV2Config";
import { sumAuctionValueForDraftablePool } from "../src/lib/rosterUniverseValuationCalibration";
import type { LeanPlayer } from "../src/types/brain";
import mongoose from "mongoose";

const TRACKED = [
  "Aaron Judge",
  "Julio Rodríguez",
  "Bobby Witt Jr.",
  "José Ramírez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Anthony Volpe",
  "Tarik Skubal",
  "Jarren Duran",
  "Riley Greene",
  "Drew Rasmussen",
  "Bryan Woo",
  "Will Warren",
  "Camilo Doval",
  "Fernando Cruz",
  "Austin Wells",
  "Spencer Jones",
];

type Scenario = {
  id: string;
  label: string;
  calibration: HybridSurplusCalibration;
};

/** Disable hybrid lift entirely (slot-only surplus control). */
const NO_HYBRID: HybridSurplusCalibration = {
  eliteGateMin: 999,
  hybridCap: 0,
  strengthMultiplier: 0,
};

const SCENARIOS: Scenario[] = [
  {
    id: "1_stage1_baseline",
    label: "Stage 1 baseline (hard gate 60.5, cap 46, mult 2.15)",
    calibration: { ...STAGE1_HYBRID_SURPLUS_CALIBRATION },
  },
  {
    id: "7_stage2_default",
    label: "Stage 2 default (smooth + position-aware, cap 46)",
    calibration: { ...DEFAULT_HYBRID_SURPLUS_CALIBRATION },
  },
  {
    id: "2_smooth_lift",
    label: "Smooth hybrid lift (gate 56, cap 44, mult 2.0, ramp 5)",
    calibration: {
      eliteGateMin: 56,
      hybridCap: 44,
      strengthMultiplier: 2,
      gateMode: "smooth",
      smoothRampSpan: 5,
    },
  },
  {
    id: "3_position_aware",
    label: "Position-aware saturated floor (same as Stage 2 default)",
    calibration: { ...DEFAULT_HYBRID_SURPLUS_CALIBRATION },
  },
  {
    id: "4_cap_protected",
    label: "Cap-protected lift (smooth 56, cap 32, mult 1.65)",
    calibration: {
      eliteGateMin: 56,
      hybridCap: 32,
      strengthMultiplier: 1.65,
      gateMode: "smooth",
      smoothRampSpan: 6,
    },
  },
  {
    id: "5_slot_only_no_hybrid",
    label: "Slot-only (no hybrid lift — control)",
    calibration: NO_HYBRID,
  },
  {
    id: "6_smooth_position_aware",
    label: "Recommended: smooth gate 56 + position-aware scarce slots",
    calibration: {
      eliteGateMin: 56,
      hybridCap: 44,
      strengthMultiplier: 2,
      gateMode: "smooth",
      smoothRampSpan: 5,
      minCategoryProjection: 40,
      scarceSlotsOnly: ["C", "SS", "2B", "3B", "1B", "MI", "CI"],
      categoryStrongGateRelax: 4,
    },
  },
];

function categoryProjectionFromPlayers(players: LeanPlayer[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of players) {
    const meta = (
      p.projection as { __valuation_meta__?: { projection_component?: number } }
    )?.__valuation_meta__;
    if (meta?.projection_component != null) {
      m.set(getPlayerId(p), meta.projection_component);
    }
  }
  return m;
}

function curveMetrics(draftableVals: number[]) {
  const ge40 = draftableVals.filter((v) => v >= 40).length;
  const ge30 = draftableVals.filter((v) => v >= 30).length;
  const ge20 = draftableVals.filter((v) => v >= 20).length;
  const ge10 = draftableVals.filter((v) => v >= 10).length;
  const plateau48 = draftableVals.filter((v) => v >= 47.5 && v <= 48.5).length;
  return { ge40, ge30, ge20, ge10, plateau_at_48: plateau48 };
}

function largestDropTop75(vals: number[]) {
  let maxDrop = 0;
  for (let i = 0; i < Math.min(74, vals.length - 1); i++) {
    maxDrop = Math.max(maxDrop, vals[i]! - vals[i + 1]!);
  }
  return maxDrop;
}

function cliff15to5(vals: number[]) {
  let n = 0;
  for (let i = 0; i < vals.length - 1; i++) {
    if (vals[i]! >= 15 && vals[i + 1]! <= 5 && vals[i]! - vals[i + 1]! >= 10) n++;
  }
  return n;
}

async function main() {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8"),
  );
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
  await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
  const pool = await loadMongoCatalogForEngine(undefined);
  await mongoose.disconnect();

  const poolInj = applyInjuryOverridesToPool(
    filterValuationUniverse(pool, { leagueScope: nested.league_scope }),
    nested.injury_overrides,
  );
  const positionOverrides = positionOverridesFromRequest(nested.position_overrides);
  const basePlayers = scoringAwareBaselinePlayers(
    poolInj,
    nested.scoring_format,
    nested.scoring_categories,
    nested.roster_slots,
    positionOverrides,
  );
  const categoryProjectionById = categoryProjectionFromPlayers(basePlayers);
  const rosteredPlayersForSlots = buildRosteredPlayersForSlotEngine(nested);
  const remainingLeagueSlots = computeRemainingLeagueRosterSlots(
    nested.roster_slots,
    nested.num_teams,
    nested.drafted_players,
    [],
  );

  const baselineById = new Map<string, number>();
  for (const p of basePlayers) {
    baselineById.set(getPlayerId(p), p.value || 0);
  }
  const draftedIds = new Set(nested.drafted_players.map((d) => d.player_id));
  const undrafted = basePlayers.filter((p) => !draftedIds.has(getPlayerId(p)));
  const budgetRemaining = computeBudgetRemaining({
    draftedPlayers: nested.drafted_players,
    totalBudgetPerTeam: nested.total_budget,
    numTeams: nested.num_teams,
  });

  const scenarioRows: Record<string, unknown>[] = [];
  const playersByScenario: Record<string, unknown> = {};

  for (const scenario of SCENARIOS) {
    const response = calculateInflation(
      basePlayers,
      nested.drafted_players,
      nested.total_budget,
      nested.num_teams,
      nested.roster_slots,
      nested.league_scope,
      {
        deterministic: true,
        seed: 42,
        inflationModel: "replacement_slots_v2",
        auctionCurveModel: "adaptive_surplus_v1",
        remainingLeagueSlots,
        rosteredPlayersForSlots,
        positionOverrides,
        explainValuationRows: true,
        hybridSurplusCalibration: scenario.calibration,
        categoryProjectionById,
        inflationCap: 3,
        inflationFloor: 0.25,
      },
    );

    const draftable = new Set(response.draftable_player_ids ?? []);
    const draftableVals = response.valuations
      .filter((v) => draftable.has(v.player_id))
      .map((v) => v.auction_value)
      .sort((a, b) => b - a);

    const { sum: draftableSum } = sumAuctionValueForDraftablePool(
      response.valuations,
      response,
    );
    const minBid = response.min_bid ?? 1;
    let surplusConservation = 0;
    for (const v of response.valuations) {
      if (!draftable.has(v.player_id)) continue;
      surplusConservation += Math.max(0, v.auction_value - minBid);
    }

    const v2 = computeReplacementSlotsV2(
      undrafted,
      rosteredPlayersForSlots,
      nested.roster_slots,
      nested.num_teams,
      budgetRemaining,
      baselineById,
      {
        deterministic: true,
        seed: 42,
        positionOverrides,
        hybridSurplusCalibration: scenario.calibration,
        categoryProjectionById,
      },
    );

    const repl = response.replacement_values_by_slot_or_position ?? {};
    const utilRepl = repl.UTIL ?? repl.Util ?? 0;

    scenarioRows.push({
      id: scenario.id,
      label: scenario.label,
      draftable_pool_size: response.draftable_player_ids?.length ?? 0,
      total_surplus_mass: response.total_surplus_mass,
      inflation_factor: response.inflation_factor,
      surplus_cash: response.surplus_cash,
      surplus_conservation_delta:
        (response.surplus_cash ?? 0) - surplusConservation,
      util_replacement: utilRepl,
      ...curveMetrics(draftableVals),
      largest_adjacent_drop_top_75: largestDropTop75(draftableVals),
      cliff_15_to_5_count: cliff15to5(draftableVals),
      endgame_above_20: draftableVals.slice(75).filter((v) => v > 20).length,
      top_25_auction_values: draftableVals.slice(0, 25),
    });

    playersByScenario[scenario.id] = TRACKED.map((name) => {
      const v = response.valuations.find((x) => x.name === name);
      const id = v?.player_id;
      const slotOnly =
        id != null ? (v2.playerIdToSlotOnlySurplusBasis?.get(id) ?? null) : null;
      const hybridLift = id != null ? (v2.playerIdToHybridLift?.get(id) ?? 0) : 0;
      const finalSb = id != null ? (v2.playerIdToSurplusBasis.get(id) ?? null) : null;
      const ve = v?.valuation_explain;
      return {
        name,
        assigned_slot: id != null ? (v2.playerIdToAssignedSlot?.get(id) ?? null) : null,
        replacement_value_used: ve?.replacement_value_used ?? null,
        replacement_key_used: ve?.replacement_key_used ?? null,
        slot_surplus: slotOnly,
        hybrid_lift: hybridLift > 0 ? hybridLift : null,
        final_surplus_basis: finalSb,
        tier: ve?.auction_curve_tier ?? null,
        auction_value: v?.auction_value ?? null,
        in_draftable_pool: v ? draftable.has(v.player_id) : false,
        valuation_row: Boolean(v),
        catalog_in_pool: poolInj.some((p) => p.name === name),
      };
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    branch: "engine/stage2-hybrid-calibration",
    fixture: "pre_draft",
    constraints: [
      "Stage 1 UTIL/BN correctness preserved",
      "No ADP",
      "draftable pool not widened",
    ],
    scenario_comparison: scenarioRows,
    tracked_players_by_scenario: playersByScenario,
    product_targets: {
      judge_julio: [35, 42],
      witt: [25, 35],
      cal_raleigh: [20, 32],
      ramirez: [12, 25],
      vlad: [8, 18],
      gunnar: [8, 18],
    },
  };

  const outPath = process.argv[2] ?? "tmp/stage2-calibration-matrix.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
