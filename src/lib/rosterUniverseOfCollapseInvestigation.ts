import type { LeanPlayer } from "../types/brain";
import type { ValuedPlayer } from "../types/valuation";
import { getPlayerId } from "./playerId";

/** MLB ids from latest calibration guardrail collapses (Mongo ≥$20 → roster ≤$1.05). */
export const ROSTER_UNIVERSE_OF_COLLAPSE_FOCUS_IDS = [
  "666176",
  "663757",
  "687597",
  "669065",
  "691016",
] as const;

export function leanPrimaryOutfield(p: LeanPlayer): boolean {
  const pos = (p.position ?? "").toUpperCase().trim();
  return pos === "LF" || pos === "CF" || pos === "RF" || pos === "OF";
}

/** True if primary or secondary positions include an OF corner/carry token. */
export function leanCarriesOutfieldToken(p: LeanPlayer): boolean {
  const bag = new Set<string>();
  const add = (s: string | undefined) => {
    if (!s) return;
    for (const t of String(s).split(/[,/\s]+/)) {
      const u = t.toUpperCase().trim();
      if (u) bag.add(u);
    }
  };
  add(p.position);
  for (const x of p.positions ?? []) add(String(x));
  for (const tok of bag) {
    if (tok === "LF" || tok === "CF" || tok === "RF" || tok === "OF") return true;
  }
  return false;
}

export function leanProjectionSummary(p: LeanPlayer): Record<string, unknown> {
  const proj = p.projection as Record<string, unknown> | undefined;
  if (!proj) return { note: "no_projection_object" };
  const out: Record<string, unknown> = {};
  const bat = proj.batting as Record<string, unknown> | undefined;
  if (bat) {
    for (const k of [
      "runs",
      "hr",
      "rbi",
      "sb",
      "avg",
      "obp",
      "plateAppearances",
      "atBats",
    ] as const) {
      if (bat[k] !== undefined) out[`bat_${k}`] = bat[k];
    }
  }
  const pit = proj.pitching as Record<string, unknown> | undefined;
  if (pit) {
    for (const k of ["era", "whip", "wins", "saves", "strikeouts", "innings", "holds"] as const) {
      if (pit[k] !== undefined) out[`pit_${k}`] = pit[k];
    }
  }
  if (Object.keys(out).length === 0) out.note = "projection_empty_shape";
  return out;
}

export function valuedRowExplainCore(v: ValuedPlayer): {
  baseline_value: number;
  auction_value: number;
  effective_positions: string[] | null;
  replacement_key_used: string | null;
  replacement_value_used: number | null;
  surplus_basis: number | null;
  inflation_factor: number;
  auction_rank: number;
  catalog_rank: number;
  market_adp: number | null;
} {
  const ex = v.valuation_explain;
  const dbg = v.debug_v2;
  return {
    baseline_value: v.baseline_value,
    auction_value: v.auction_value,
    effective_positions: ex?.effective_positions ?? null,
    replacement_key_used: ex?.replacement_key_used ?? dbg?.replacement_key_used ?? null,
    replacement_value_used: ex?.replacement_value_used ?? dbg?.replacement_value_used ?? null,
    surplus_basis: ex?.surplus_basis ?? dbg?.surplus_basis ?? null,
    inflation_factor: ex?.inflation_factor ?? v.inflation_factor,
    auction_rank: v.auction_rank,
    catalog_rank: v.catalog_rank,
    market_adp:
      v.market_adp != null && Number.isFinite(v.market_adp) ? (v.market_adp as number) : null,
  };
}

export function valuationRowIsPrimaryOutfield(v: ValuedPlayer): boolean {
  const pos = (v.position ?? "").toUpperCase().trim();
  if (pos === "LF" || pos === "CF" || pos === "RF" || pos === "OF") return true;
  const eff = v.valuation_explain?.effective_positions ?? [];
  return eff.some((p) => {
    const u = p.toUpperCase().trim();
    return u === "LF" || u === "CF" || u === "RF" || u === "OF";
  });
}

export type CollapseDiagnosticVerdict =
  | "expected_wider_pool_correction"
  | "of_replacement_level_artifact"
  | "projection_or_outlier_issue"
  | "roster_universe_candidate_issue"
  | "formula_or_tuning_signal";

export function diagnoseOfStyleCollapse(args: {
  old_replacement_key: string | null;
  new_replacement_key: string | null;
  old_replacement_value: number | null;
  new_replacement_value: number | null;
  old_surplus_basis: number | null;
  new_surplus_basis: number | null;
  old_baseline_value: number;
  new_baseline_value: number;
  old_auction_value: number;
  new_auction_value: number;
}): { verdict: CollapseDiagnosticVerdict; rationale: string } {
  const rkOld = args.old_replacement_key ?? "";
  const rkNew = args.new_replacement_key ?? "";
  const ofish = (k: string) => k === "OF" || k.includes("OF");

  if (rkOld !== rkNew) {
    return {
      verdict: "of_replacement_level_artifact",
      rationale: `Replacement token changed (${rkOld || "null"} → ${rkNew || "null"}), so surplus routing is not apples-to-apples across pools.`,
    };
  }

  const orv = args.old_replacement_value;
  const nrv = args.new_replacement_value;
  if (
    orv != null &&
    nrv != null &&
    ofish(rkOld) &&
    nrv > orv + 8 &&
    (args.new_surplus_basis ?? 0) <= 0.01 &&
    (args.old_surplus_basis ?? 0) > 3
  ) {
    return {
      verdict: "of_replacement_level_artifact",
      rationale:
        "OF-style replacement_value_used rose materially while surplus_basis collapsed to ~0 — marginal OF dollars were absorbed by a higher replacement bar plus many competing bodies.",
    };
  }

  const mb = args.old_baseline_value;
  const rb = args.new_baseline_value;
  if (mb > 8 && rb < mb * 0.25) {
    return {
      verdict: "projection_or_outlier_issue",
      rationale: `Baseline fell very sharply (${mb.toFixed(2)} → ${rb.toFixed(2)}) without an obvious replacement-key story — worth spot-checking blended stats / PA for this player.`,
    };
  }

  if (mb > 5 && rb >= mb * 0.55 && args.new_auction_value <= 1.05 && args.old_auction_value >= 20) {
    return {
      verdict: "expected_wider_pool_correction",
      rationale:
        "Baseline stayed in rough family but auction dollars went to the floor — classic wider-pool surplus dilution under replacement_slots_v2 with fixed league budget.",
    };
  }

  if (args.new_auction_value <= 1.05 && args.old_auction_value >= 20 && rb < mb * 0.55) {
    return {
      verdict: "roster_universe_candidate_issue",
      rationale:
        "Meaningful baseline drop when many similar profiles enter the pool — not necessarily wrong, but driven by who roster-universe admits as valuation_eligible.",
    };
  }

  return {
    verdict: "formula_or_tuning_signal",
    rationale: "Pattern does not match the common wide-pool / OF-bar templates; treat as manual review.",
  };
}

export function rosterPlayersNewVsMongo(args: {
  rosterPool: LeanPlayer[];
  mongoIds: Set<string>;
}): { new_mlb_count: number; new_primary_outfield_count: number } {
  let newMlb = 0;
  let newOf = 0;
  for (const p of args.rosterPool) {
    const id = getPlayerId(p);
    if (args.mongoIds.has(id)) continue;
    newMlb++;
    if (leanPrimaryOutfield(p)) newOf++;
  }
  return { new_mlb_count: newMlb, new_primary_outfield_count: newOf };
}
