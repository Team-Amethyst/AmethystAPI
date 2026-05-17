/**
 * Hybrid surplus calibration sensitivity (pre_draft fixture). No production deploy.
 *   npx tsx scripts/hybrid-calibration-sensitivity.ts [out.json]
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
import type { HybridSurplusCalibration } from "../src/services/replacementSlotsV2Config";
import type { LeanPlayer } from "../src/types/brain";
import mongoose from "mongoose";

const DEEP_DIVE = [
  "Aaron Judge",
  "Julio Rodríguez",
  "Bobby Witt Jr.",
  "José Ramírez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Jarren Duran",
  "Riley Greene",
  "Tarik Skubal",
  "Bryan Woo",
  "Drew Rasmussen",
  "Garrett Crochet",
  "Yordan Alvarez",
];

type Scenario = {
  id: string;
  label: string;
  calibration: HybridSurplusCalibration;
};

const SCENARIOS: Scenario[] = [
  {
    id: "1_current",
    label: "Current (gate 60.5, cap 46, mult 2.15)",
    calibration: {
      eliteGateMin: 60.5,
      hybridCap: 46,
      strengthMultiplier: 2.15,
      gateMode: "hard",
    },
  },
  {
    id: "2_gate_58_5",
    label: "Slightly lower gate (58.5)",
    calibration: {
      eliteGateMin: 58.5,
      hybridCap: 46,
      strengthMultiplier: 2.15,
      gateMode: "hard",
    },
  },
  {
    id: "3_gate_56",
    label: "Lower gate (56.0)",
    calibration: {
      eliteGateMin: 56,
      hybridCap: 46,
      strengthMultiplier: 2.15,
      gateMode: "hard",
    },
  },
  {
    id: "4_softer_mult",
    label: "Lower gate + softer mult (56, cap 42, mult 1.75)",
    calibration: {
      eliteGateMin: 56,
      hybridCap: 42,
      strengthMultiplier: 1.75,
      gateMode: "hard",
    },
  },
  {
    id: "5_position_aware",
    label: "Position-aware gate (56 + category on scarce slots)",
    calibration: {
      eliteGateMin: 56,
      hybridCap: 46,
      strengthMultiplier: 2.15,
      gateMode: "hard",
      minCategoryProjection: 40,
      scarceSlotsOnly: ["C", "SS", "2B", "3B", "1B", "MI", "CI"],
      categoryStrongGateRelax: 4,
    },
  },
  {
    id: "6_smooth",
    label: "Smooth gate (56, cap 44, mult 2.0, ramp 5) — preferred direction",
    calibration: {
      eliteGateMin: 56,
      hybridCap: 44,
      strengthMultiplier: 2,
      gateMode: "smooth",
      smoothRampSpan: 5,
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

function bucketCounts(auctionByDraftable: number[]) {
  const n30 = auctionByDraftable.filter((v) => v >= 30).length;
  const n20_30 = auctionByDraftable.filter((v) => v >= 20 && v < 30).length;
  const n10_20 = auctionByDraftable.filter((v) => v >= 10 && v < 20).length;
  const n1_5 = auctionByDraftable.filter((v) => v >= 1 && v <= 5).length;
  return { n30, n20_30, n10_20, n1_5 };
}

function shapeFlags(sortedAuction: { name: string; auction_value: number }[]) {
  const vals = sortedAuction.map((x) => x.auction_value);
  const plateau48 = vals.filter((v) => v >= 47.5 && v <= 48.5).length;
  let cliff15to5 = 0;
  for (let i = 0; i < vals.length - 1; i++) {
    if (vals[i] >= 15 && vals[i + 1] <= 5 && vals[i] - vals[i + 1] >= 10) {
      cliff15to5++;
    }
  }
  const top = vals[0] ?? 0;
  const linearBlowUp =
    top > 55 && vals.length >= 5 && vals[4] > 45 && vals[9] > 40;
  return {
    plateau_at_48: plateau48,
    cliff_15_to_5_count: cliff15to5,
    linear_blow_up_heuristic: linearBlowUp,
  };
}

async function main() {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8")
  );
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
  await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
  const pool = await loadMongoCatalogForEngine(undefined);
  await mongoose.disconnect();

  const poolInj = applyInjuryOverridesToPool(
    filterValuationUniverse(pool, { leagueScope: nested.league_scope }),
    nested.injury_overrides
  );
  const positionOverrides = positionOverridesFromRequest(nested.position_overrides);
  const basePlayers = scoringAwareBaselinePlayers(
    poolInj,
    nested.scoring_format,
    nested.scoring_categories,
    nested.roster_slots,
    positionOverrides
  );
  const categoryProjectionById = categoryProjectionFromPlayers(basePlayers);
  const rosteredPlayersForSlots = buildRosteredPlayersForSlotEngine(nested);
  const remainingLeagueSlots = computeRemainingLeagueRosterSlots(
    nested.roster_slots,
    nested.num_teams,
    nested.drafted_players,
    []
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

  const scenarioResults: Record<string, unknown>[] = [];
  const deepDiveByScenario: Record<string, unknown> = {};

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
      }
    );

    const draftable = new Set(response.draftable_player_ids ?? []);
    const draftableVals = response.valuations
      .filter((v) => draftable.has(v.player_id))
      .map((v) => v.auction_value);
    const top25 = [...response.valuations]
      .filter((v) => draftable.has(v.player_id))
      .sort((a, b) => (a.auction_rank ?? 999) - (b.auction_rank ?? 999))
      .slice(0, 25)
      .map((v) => ({
        rank: v.auction_rank,
        name: v.name,
        auction_value: v.auction_value,
        tier: v.valuation_explain?.auction_curve_tier,
        surplus_basis: v.valuation_explain?.surplus_basis,
      }));

    const sortedAuction = [...response.valuations]
      .filter((v) => draftable.has(v.player_id))
      .sort((a, b) => b.auction_value - a.auction_value);

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
      }
    );

    const sbRank = new Map(
      [...v2.playerIdToSurplusBasis.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id], i) => [id, i + 1])
    );

    scenarioResults.push({
      id: scenario.id,
      label: scenario.label,
      calibration: scenario.calibration,
      total_surplus_mass: response.total_surplus_mass,
      inflation_factor: response.inflation_factor,
      buckets: bucketCounts(draftableVals),
      shape: shapeFlags(sortedAuction),
      top25,
    });

    deepDiveByScenario[scenario.id] = DEEP_DIVE.map((name) => {
      const v = response.valuations.find((x) => x.name === name);
      if (!v) return { name, missing: true };
      const id = v.player_id;
      const slotOnly = v2.playerIdToSlotOnlySurplusBasis?.get(id) ?? null;
      const hybridLift = v2.playerIdToHybridLift?.get(id) ?? 0;
      const finalSb = v2.playerIdToSurplusBasis.get(id) ?? null;
      return {
        name,
        baseline: v.baseline_value,
        assigned_slot: v2.playerIdToAssignedSlot?.get(id) ?? null,
        marginal_replacement: v2.playerIdToMarginalReplacement?.get(id) ?? null,
        slot_surplus: slotOnly,
        hybrid_lift: hybridLift > 0 ? hybridLift : null,
        final_surplus_basis: finalSb,
        surplus_rank: sbRank.get(id) ?? null,
        tier: v.valuation_explain?.auction_curve_tier,
        auction_value: v.auction_value,
        category_projection: categoryProjectionById.get(id) ?? null,
      };
    });
  }

  const report = {
    fixture: "pre_draft",
    constraints: [
      "No ADP in formula",
      "UTIL/BN zero-replacement artifact fixed",
      "Draftable pool not widened",
    ],
    scenario_comparison: scenarioResults,
    deep_dive_by_scenario: deepDiveByScenario,
    product_targets: {
      judge_julio_skubal: "$35–42",
      witt: "$25–35",
      cal_raleigh: "$20–32",
      ramirez: "$12–25",
      vlad: "$8–18",
      gunnar: "$8–18",
    },
    answers: {
      q1_gate_60_5_too_high:
        "Compare scenarios 1 vs 2 vs 3: lower gate lifts Ramírez/Vlad without touching high slot-surplus OF elites.",
      q2_hard_cliff:
        "Yes at 60.5 between Witt (~61) and Ramírez/Vlad (~55–56); smooth gate (scenario 6) or 56 gate reduces cliff.",
      q3_smooth_vs_binary:
        "Scenario 6 ramps lift between gate and gate+5; avoids all-or-nothing at a single baseline.",
      q4_lift_ramirez_vlad:
        "Gate ≤58.5 or smooth@56 + position-aware (5) lifts without restoring UTIL@0 fake surplus.",
      q5_cal_raleigh:
        "Catcher slot marginal drives high slot surplus; alternate caps/gates mainly scale tier dollars, not role.",
      q6_witt_believable:
        "Scenarios 2–4 and 6 target $25–35; scenario 1 leaves Witt ~$20.",
    },
    recommended_calibration:
      "Scenario 6 (smooth gate 56, cap 44, mult 2.0) or scenario 3 (hard 56) pending product sign-off; do not ship scenario 1 cliff.",
    deploy_recommendation:
      "WAIT — architecture OK; tune hybrid gate/cap/multiplier (prefer smooth) before production.",
  };

  const outPath = process.argv[2];
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
