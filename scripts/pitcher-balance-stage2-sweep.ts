/**
 * Stage-2 pitcher balance combinations (Mongo read-only; in-memory patches).
 * Anchors on pitcher intrinsic +3 vs shipped baseline.
 *
 *   MONGO_URI=... npx ts-node --project tsconfig.scripts.json scripts/pitcher-balance-stage2-sweep.ts
 *
 * Writes tmp/pitcher-balance-stage2-sweep.json
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import type { LeanPlayer, ValuedPlayer } from "../src/types/brain";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { getPlayerId } from "../src/lib/playerId";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { ROTO_Z_HITTER, ROTO_Z_PITCHER } from "../src/services/baselineRotoZConfig";
import { ROTO_INTRINSIC_BASE_PITCHER_REF } from "../src/services/baselineValueEngine";
import { SLOT_REPLACEMENT_PERCENTILE } from "../src/services/replacementSlotsV2Config";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "pitcher-balance-stage2-sweep.json");

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function positionalMix(rows: ValuedPlayer[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) {
    const pos = (r.position ?? "UNK").trim().toUpperCase();
    m[pos] = (m[pos] ?? 0) + 1;
  }
  return m;
}

function traceRow(label: string, v: ValuedPlayer | undefined): Record<string, unknown> | null {
  if (!v) return null;
  const ex = v.valuation_explain;
  return {
    label,
    player_id: v.player_id,
    name: v.name,
    position: v.position,
    baseline_value: v.baseline_value,
    auction_value: v.auction_value,
    adjusted_value: v.adjusted_value,
    inflation_factor_row: v.inflation_factor,
    scarcity_adjustment: v.scarcity_adjustment,
    inflation_adjustment: v.inflation_adjustment,
    valuation_explain: ex
      ? {
          effective_positions: ex.effective_positions,
          replacement_key_used: ex.replacement_key_used,
          replacement_value_used: ex.replacement_value_used,
          surplus_basis: ex.surplus_basis,
          inflation_factor: ex.inflation_factor,
          pool_size: ex.pool_size,
          roster_demand_slots: ex.roster_demand_slots,
          pool_to_slot_ratio: ex.pool_to_slot_ratio,
        }
      : null,
    baseline_components: v.baseline_components,
  };
}

type ExpResult = {
  label: string;
  ok: boolean;
  issues?: string[];
  hitter_share_auction: number | null;
  pitcher_share_auction: number | null;
  top_player: { player_id: string; name?: string; position?: string; auction_value: number } | null;
  top_hitter: { player_id: string; name?: string; position?: string; auction_value: number } | null;
  top_pitcher: { player_id: string; name?: string; position?: string; auction_value: number } | null;
  top25_positional_mix: Record<string, number>;
  threshold_auction: { ge50: number; ge40: number; ge30: number; ge20: number };
  near_one_auction: number;
  budget_ratio: number | null;
  replacement_OF: number | null;
  replacement_SP: number | null;
  replacement_RP: number | null;
  total_surplus_mass: number | null;
  inflation_factor: number | null;
  OF_percentile_effective?: number;
  SP_percentile_effective?: number;
  RP_percentile_effective?: number;
  OF_replacement_changed_vs_shipped?: boolean;
  SP_replacement_changed_vs_shipped?: boolean;
  RP_replacement_changed_vs_shipped?: boolean;
};

function runOne(
  label: string,
  pool: LeanPlayer[],
  shippedRepl: { OF: number; SP: number; RP: number } | null,
  patch: () => void,
  unpatch: () => void
): ExpResult {
  patch();
  try {
    const input = buildDraftroomStandardValuationInput({
      explain_valuation_rows: true,
      inflation_model: "replacement_slots_v2",
      deterministic: true,
      seed: 42,
    });
    const wf = executeValuationWorkflow(pool, input, {});
    if (!wf.ok) {
      return {
        label,
        ok: false,
        issues: wf.issues,
        hitter_share_auction: null,
        pitcher_share_auction: null,
        top_player: null,
        top_hitter: null,
        top_pitcher: null,
        top25_positional_mix: {},
        threshold_auction: { ge50: 0, ge40: 0, ge30: 0, ge20: 0 },
        near_one_auction: 0,
        budget_ratio: null,
        replacement_OF: null,
        replacement_SP: null,
        replacement_RP: null,
        total_surplus_mass: null,
        inflation_factor: null,
      };
    }
    const res = wf.response;
    const ov = positionOverridesFromRequest(input.position_overrides);
    const byId = new Map(pool.map((p) => [getPlayerId(p), p]));

    let hp = 0,
      pp = 0;
    for (const r of res.valuations) {
      const lp = byId.get(r.player_id);
      if (!lp) continue;
      if (isPitcherForBaseline(lp, ov)) pp += num(r.auction_value);
      else hp += num(r.auction_value);
    }

    const sorted = [...res.valuations].sort((a, b) => num(b.auction_value) - num(a.auction_value));
    const hitters = sorted.filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && !isPitcherForBaseline(lp, ov);
    });
    const pitchers = sorted.filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && isPitcherForBaseline(lp, ov);
    });

    const top = sorted[0] ?? null;
    const topHit = hitters[0] ?? null;
    const topPit = pitchers[0] ?? null;

    let ge50 = 0,
      ge40 = 0,
      ge30 = 0,
      ge20 = 0,
      near1 = 0;
    for (const r of res.valuations) {
      const av = num(r.auction_value);
      if (av >= 50) ge50++;
      if (av >= 40) ge40++;
      if (av >= 30) ge30++;
      if (av >= 20) ge20++;
      if (av > 0 && av <= 1.25) near1++;
    }

    const leagueBudget = input.total_budget * input.num_teams;
    const sumAll = res.valuations.reduce((s, r) => s + num(r.auction_value), 0);

    const rv = res.replacement_values_by_slot_or_position ?? {};
    const rOF = rv.OF ?? null;
    const rSP = rv.SP ?? null;
    const rRP = rv.RP ?? null;

    return {
      label,
      ok: true,
      hitter_share_auction: hp + pp > 0 ? hp / (hp + pp) : null,
      pitcher_share_auction: hp + pp > 0 ? pp / (hp + pp) : null,
      top_player: top
        ? {
            player_id: top.player_id,
            name: top.name,
            position: top.position,
            auction_value: num(top.auction_value),
          }
        : null,
      top_hitter: topHit
        ? {
            player_id: topHit.player_id,
            name: topHit.name,
            position: topHit.position,
            auction_value: num(topHit.auction_value),
          }
        : null,
      top_pitcher: topPit
        ? {
            player_id: topPit.player_id,
            name: topPit.name,
            position: topPit.position,
            auction_value: num(topPit.auction_value),
          }
        : null,
      top25_positional_mix: positionalMix(sorted.slice(0, 25)),
      threshold_auction: { ge50, ge40, ge30, ge20 },
      near_one_auction: near1,
      budget_ratio: leagueBudget > 0 ? sumAll / leagueBudget : null,
      replacement_OF: rOF,
      replacement_SP: rSP,
      replacement_RP: rRP,
      total_surplus_mass: res.total_surplus_mass ?? null,
      inflation_factor: res.inflation_factor ?? null,
      OF_percentile_effective: SLOT_REPLACEMENT_PERCENTILE.OF,
      SP_percentile_effective: SLOT_REPLACEMENT_PERCENTILE.SP,
      RP_percentile_effective: SLOT_REPLACEMENT_PERCENTILE.RP,
      ...(shippedRepl
        ? {
            OF_replacement_changed_vs_shipped:
              rOF != null ? Math.abs(rOF - shippedRepl.OF) > 1e-6 : undefined,
            SP_replacement_changed_vs_shipped:
              rSP != null ? Math.abs(rSP - shippedRepl.SP) > 1e-6 : undefined,
            RP_replacement_changed_vs_shipped:
              rRP != null ? Math.abs(rRP - shippedRepl.RP) > 1e-6 : undefined,
          }
        : {}),
    };
  } finally {
    unpatch();
  }
}

type Snap = {
  intr: number;
  zh: { zScale: number; zLo: number; zHi: number };
  zp: { zScale: number; zLo: number; zHi: number };
  repl: Record<string, number>;
};

function restoreAll(s: Snap): void {
  ROTO_INTRINSIC_BASE_PITCHER_REF.value = s.intr;
  Object.assign(ROTO_Z_HITTER, s.zh);
  Object.assign(ROTO_Z_PITCHER, s.zp);
  Object.assign(SLOT_REPLACEMENT_PERCENTILE, s.repl);
}

function applyStage2Patch(
  label: string,
  s: Snap,
  intrinsicBump: number
): void {
  restoreAll(s);
  ROTO_INTRINSIC_BASE_PITCHER_REF.value = s.intr + intrinsicBump;

  switch (label) {
    case "intrinsic_plus_3_only":
      break;
    case "intrinsic_plus_3_p_zscale_plus_5pct":
      Object.assign(ROTO_Z_PITCHER, { zScale: s.zp.zScale * 1.05 });
      break;
    case "intrinsic_plus_3_p_zscale_plus_10pct":
      Object.assign(ROTO_Z_PITCHER, { zScale: s.zp.zScale * 1.1 });
      break;
    case "intrinsic_plus_3_p_zHi_plus_0p05":
      Object.assign(ROTO_Z_PITCHER, { zHi: s.zp.zHi + 0.05 });
      break;
    case "intrinsic_plus_3_p_zHi_plus_0p10":
      Object.assign(ROTO_Z_PITCHER, { zHi: s.zp.zHi + 0.1 });
      break;
    case "intrinsic_plus_3_h_zscale_minus_3pct":
      Object.assign(ROTO_Z_HITTER, { zScale: s.zh.zScale * 0.97 });
      break;
    case "intrinsic_plus_3_h_zscale_minus_5pct":
      Object.assign(ROTO_Z_HITTER, { zScale: s.zh.zScale * 0.95 });
      break;
    case "intrinsic_plus_3_OF_repl_pct_plus_0p03":
      Object.assign(SLOT_REPLACEMENT_PERCENTILE, { OF: s.repl.OF + 0.03 });
      break;
    case "intrinsic_plus_3_OF_repl_pct_plus_0p05":
      Object.assign(SLOT_REPLACEMENT_PERCENTILE, { OF: s.repl.OF + 0.05 });
      break;
    case "intrinsic_plus_3_combo_modest":
      Object.assign(ROTO_Z_PITCHER, { zScale: s.zp.zScale * 1.05 });
      Object.assign(ROTO_Z_HITTER, { zScale: s.zh.zScale * 0.97 });
      Object.assign(SLOT_REPLACEMENT_PERCENTILE, { OF: s.repl.OF + 0.03 });
      break;
    default:
      throw new Error(`unknown label ${label}`);
  }
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

  const snap: Snap = {
    intr: ROTO_INTRINSIC_BASE_PITCHER_REF.value,
    zh: { zScale: ROTO_Z_HITTER.zScale, zLo: ROTO_Z_HITTER.zLo, zHi: ROTO_Z_HITTER.zHi },
    zp: { zScale: ROTO_Z_PITCHER.zScale, zLo: ROTO_Z_PITCHER.zLo, zHi: ROTO_Z_PITCHER.zHi },
    repl: { ...SLOT_REPLACEMENT_PERCENTILE },
  };

  const restore = () => restoreAll(snap);

  /* Shipped baseline replacement levels (for delta flags) */
  const shippedRow = runOne("shipped_baseline_metrics_only", pool, null, restore, restore);
  const shippedRepl = {
    OF: shippedRow.replacement_OF ?? NaN,
    SP: shippedRow.replacement_SP ?? NaN,
    RP: shippedRow.replacement_RP ?? NaN,
  };

  const INTRINSIC_PLUS = 3;
  const labels = [
    "intrinsic_plus_3_only",
    "intrinsic_plus_3_p_zscale_plus_5pct",
    "intrinsic_plus_3_p_zscale_plus_10pct",
    "intrinsic_plus_3_p_zHi_plus_0p05",
    "intrinsic_plus_3_p_zHi_plus_0p10",
    "intrinsic_plus_3_h_zscale_minus_3pct",
    "intrinsic_plus_3_h_zscale_minus_5pct",
    "intrinsic_plus_3_OF_repl_pct_plus_0p03",
    "intrinsic_plus_3_OF_repl_pct_plus_0p05",
    "intrinsic_plus_3_combo_modest",
  ] as const;

  const experiments: ExpResult[] = labels.map((label) =>
    runOne(label, pool, shippedRepl, () => applyStage2Patch(label, snap, INTRINSIC_PLUS), restore)
  );

  const anchor = experiments.find((e) => e.label === "intrinsic_plus_3_only");
  const anchorTopHitter = anchor?.top_hitter?.auction_value ?? 0;

  type Ranked = ExpResult & { score: number; notes: string };
  const ranked: Ranked[] = experiments
    .filter((e) => e.ok && e.pitcher_share_auction != null)
    .map((e) => {
      const ps = e.pitcher_share_auction!;
      const tp = e.top_pitcher?.auction_value ?? 0;
      const th = e.top_hitter?.auction_value ?? 0;
      const br = e.budget_ratio ?? 0;
      let score = 0;
      let notes = "";
      if (ps >= 0.25) score += 150;
      if (ps >= 0.28) score += 120;
      if (ps >= 0.35) score += 80;
      score -= Math.abs(ps - 0.315) * 80;
      if (tp >= 20) score += 100;
      else score -= (20 - tp) * 5;
      if (tp >= 24) score += 40;
      if (br >= 1.085 && br <= 1.095) score += 50;
      else score -= Math.abs(br - 1.091) * 400;
      if (anchorTopHitter > 0 && th < anchorTopHitter * 0.85) {
        score -= 150;
        notes += "top_hitter_collapse_vs_anchor;";
      }
      if (th < 40 && anchorTopHitter >= 45) {
        score -= 80;
        notes += "star_tier_soft;";
      }
      return { ...e, score, notes };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  const inputBase = buildDraftroomStandardValuationInput({
    explain_valuation_rows: true,
    inflation_model: "replacement_slots_v2",
    deterministic: true,
    seed: 42,
  });

  /* Trace player IDs from intrinsic+3 anchor */
  restore();
  applyStage2Patch("intrinsic_plus_3_only", snap, INTRINSIC_PLUS);
  const wfAnchor = executeValuationWorkflow(pool, inputBase, {});
  restore();

  let topOfId = "";
  let topPitId = "";
  let midPitId = "";
  if (wfAnchor.ok) {
    const ov = positionOverridesFromRequest(inputBase.position_overrides);
    const byId = new Map(pool.map((p) => [getPlayerId(p), p]));
    const vals = wfAnchor.response.valuations;
    const sorted = [...vals].sort((a, b) => num(b.auction_value) - num(a.auction_value));
    const pitchers = sorted.filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && isPitcherForBaseline(lp, ov);
    });
    const hitters = sorted.filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && !isPitcherForBaseline(lp, ov);
    });
    const topOf =
      hitters.find((r) => {
        const pos = (r.position ?? "").toUpperCase();
        return ["OF", "LF", "CF", "RF"].some((x) => pos.includes(x));
      }) ?? hitters[0];
    topOfId = topOf?.player_id ?? "";
    topPitId = pitchers[0]?.player_id ?? "";
    const midIdx = Math.min(14, Math.max(0, pitchers.length - 1));
    midPitId = pitchers[midIdx]?.player_id ?? "";
  }

  let traceBefore: Record<string, unknown> | null = null;
  let traceAfter: Record<string, unknown> | null = null;

  if (best && topOfId && topPitId && midPitId) {
    restore();
    const wfBefore = executeValuationWorkflow(pool, inputBase, {});
    if (wfBefore.ok) {
      const vals = wfBefore.response.valuations;
      traceBefore = {
        production_shipped_constants: {
          ROTO_INTRINSIC_BASE_PITCHER: snap.intr,
          note: "before = shipped baseline (intrinsic 20), not intrinsic+3 anchor",
        },
        top_of_hitter: traceRow(
          "before_shipped",
          vals.find((v) => v.player_id === topOfId)
        ),
        top_pitcher: traceRow(
          "before_shipped",
          vals.find((v) => v.player_id === topPitId)
        ),
        mid_tier_pitcher: traceRow(
          "before_shipped",
          vals.find((v) => v.player_id === midPitId)
        ),
      };
    }
    restore();

    applyStage2Patch(best.label as (typeof labels)[number], snap, INTRINSIC_PLUS);
    try {
      const wfAfter = executeValuationWorkflow(pool, inputBase, {});
      if (wfAfter.ok) {
        const vals = wfAfter.response.valuations;
        traceAfter = {
          label: best.label,
          top_of_hitter: traceRow("after_best", vals.find((v) => v.player_id === topOfId)),
          top_pitcher: traceRow("after_best", vals.find((v) => v.player_id === topPitId)),
          mid_tier_pitcher: traceRow("after_best", vals.find((v) => v.player_id === midPitId)),
        };
      }
    } finally {
      restore();
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    catalog_rows: pool.length,
    anchor_intrinsic_bump: INTRINSIC_PLUS,
    shipped_snapshot: snap,
    shipped_replacement_reference: shippedRepl,
    targets_note:
      "Milestone: pitcher share ≥25%; stretch 28–35%; top pitcher ≥$20; budget ratio stable; no hitter-star collapse vs intrinsic+3 anchor.",
    experiments,
    ranked_by_score: ranked.map((r) => ({
      label: r.label,
      score: r.score,
      notes: r.notes || undefined,
      pitcher_share_auction: r.pitcher_share_auction,
      top_pitcher_auction: r.top_pitcher?.auction_value,
      top_hitter_auction: r.top_hitter?.auction_value,
      budget_ratio: r.budget_ratio,
    })),
    best_candidate: best
      ? {
          label: best.label,
          score: best.score,
          notes: best.notes || undefined,
          meets_milestone_25pct_pitchers: (best.pitcher_share_auction ?? 0) >= 0.25,
          meets_stretch_28pct: (best.pitcher_share_auction ?? 0) >= 0.28,
          top_pitcher_ge_20: (best.top_pitcher?.auction_value ?? 0) >= 20,
        }
      : null,
    formula_trace: {
      trace_player_ids: { top_of_hitter_id: topOfId, top_pitcher_id: topPitId, mid_tier_pitcher_id: midPitId },
      mid_tier_rank_note: "Mid-tier = 15th pitcher by auction_value on intrinsic+3 anchor run (0-based index 14).",
      before_shipped_baseline: traceBefore,
      after_best_candidate: traceAfter,
    },
    safe_single_commit_recommendation:
      "Do not commit a combination without review; see narrative. If one knob only: shipped intrinsic bump is risk-isolated vs multi-parameter combos.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ wrote: OUT, best: best?.label }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
