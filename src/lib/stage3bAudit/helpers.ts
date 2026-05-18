import type {
  NormalizedValuationInput,
  ValuationResponse,
} from "../../types/valuation";
import type { Stage3bCalibration } from "../../services/stage3bPitcherCalibration";
import { TRACKED_PITCHERS } from "../stage2ValuationAudit/trackedPlayers";

export const SP_DIAGNOSIS_NAMES = [...TRACKED_PITCHERS] as const;

export function boardShapeMetrics(r: ValuationResponse) {
  const ids = new Set(r.draftable_player_ids ?? []);
  const draftable = r.valuations
    .filter((v) => ids.has(v.player_id))
    .sort((a, b) => b.auction_value - a.auction_value);
  const vals = draftable.map((v) => v.auction_value);
  let drop25 = 0;
  for (let i = 0; i < Math.min(24, vals.length - 1); i++) {
    drop25 = Math.max(drop25, vals[i]! - vals[i + 1]!);
  }
  let drop75 = 0;
  for (let i = 0; i < Math.min(74, vals.length - 1); i++) {
    drop75 = Math.max(drop75, vals[i]! - vals[i + 1]!);
  }
  const spVals = draftable
    .filter((v) => {
      const slot = (v.valuation_explain?.replacement_key_used ?? "").toUpperCase();
      return slot === "SP" || slot === "RP" || slot === "P";
    })
    .map((v) => v.auction_value);
  const hitterTop = draftable
    .filter((v) => {
      const slot = (v.valuation_explain?.replacement_key_used ?? "").toUpperCase();
      return slot !== "SP" && slot !== "RP" && slot !== "P";
    })
    .slice(0, 5)
    .map((v) => v.auction_value);
  const top5Avg =
    vals.slice(0, 5).reduce((s, v) => s + v, 0) / Math.min(5, vals.length || 1);
  const top25Avg =
    vals.slice(0, 25).reduce((s, v) => s + v, 0) / Math.min(25, vals.length || 1);
  return {
    draftable_pool_size: r.draftable_player_ids?.length ?? 0,
    UTIL: r.replacement_values_by_slot_or_position?.UTIL,
    max_auction: vals[0] ?? 0,
    top5_avg: top5Avg,
    top25_avg: top25Avg,
    ge30: vals.filter((v) => v >= 30).length,
    ge20: vals.filter((v) => v >= 20).length,
    ge15: vals.filter((v) => v >= 15).length,
    ge10: vals.filter((v) => v >= 10).length,
    ge5: vals.filter((v) => v >= 5).length,
    drop25,
    drop75,
    sp_ge20: spVals.filter((v) => v >= 20).length,
    sp_ge15: spVals.filter((v) => v >= 15).length,
    sp_ge10: spVals.filter((v) => v >= 10).length,
    sp_ge5: spVals.filter((v) => v >= 5).length,
    hitter_top5_avg:
      hitterTop.reduce((s, v) => s + v, 0) / Math.min(5, hitterTop.length || 1),
    plateau_48: vals.filter((v) => v >= 47.5 && v <= 48.5).length,
    endgame_ge20:
      (r.remaining_slots ?? 99) <= 10
        ? vals.filter((v) => v >= 20).length
        : null,
    curve_reason: r.auction_curve_reason,
    phase: r.curve_inputs?.phase,
    conservation_delta: r.surplus_conservation_delta,
  };
}

export function spDiagnosisRow(
  r: ValuationResponse,
  name: string,
) {
  const norm = name.normalize("NFD").replace(/\p{M}/gu, "");
  const v = r.valuations.find(
    (x) =>
      x.name?.normalize("NFD").replace(/\p{M}/gu, "") === norm ||
      x.name === name,
  );
  const ids = new Set(r.draftable_player_ids ?? []);
  if (!v) {
    return { name, valuation_row: false as const };
  }
  const ex = v.valuation_explain;
  return {
    name: v.name,
    valuation_row: true as const,
    in_draftable_pool: ids.has(v.player_id),
    auction_value: v.auction_value,
    raw_auction_value: v.auction_value,
    auction_rank: v.auction_rank,
    baseline_value: v.baseline_value,
    surplus_basis: ex?.surplus_basis,
    assigned_slot: ex?.replacement_key_used,
    replacement_value_used: ex?.replacement_value_used,
    hybrid_lift: null as number | null,
    auction_tier: ex?.auction_curve_tier,
    auction_curve_weight: ex?.auction_curve_weight,
    projection_component: (ex as { projection_component?: number })
      ?.projection_component,
    two_way_role: ex?.two_way_role_selected,
    position: v.position,
  };
}

export function workflowWithStage3b(
  input: NormalizedValuationInput,
  stage3b?: Stage3bCalibration,
): NormalizedValuationInput {
  return {
    ...input,
    deterministic: true,
    seed: 42,
    inflation_model: "replacement_slots_v2",
    auction_curve_model: "adaptive_surplus_v1",
    explain_valuation_rows: true,
    ...(stage3b ? { stage3b_calibration: stage3b } : {}),
  };
}
