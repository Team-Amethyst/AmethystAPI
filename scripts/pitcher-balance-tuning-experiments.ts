/**
 * Controlled pitcher-balance sweeps (Mongo read-only; in-memory config patches).
 *
 *   MONGO_URI=... npx ts-node --project tsconfig.scripts.json scripts/pitcher-balance-tuning-experiments.ts
 *
 * Writes tmp/pitcher-balance-tuning-experiments.json
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import type { LeanPlayer, ValuedPlayer } from "../src/types/brain";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { getPlayerId } from "../src/lib/playerId";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { ROTO_Z_PITCHER } from "../src/services/baselineRotoZConfig";
import { ROTO_INTRINSIC_BASE_PITCHER_REF } from "../src/services/baselineValueEngine";
import { SLOT_REPLACEMENT_PERCENTILE } from "../src/services/replacementSlotsV2Config";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "pitcher-balance-tuning-experiments.json");

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
  OF_replacement_changed_vs_baseline?: boolean;
  SP_replacement_changed_vs_baseline?: boolean;
  RP_replacement_changed_vs_baseline?: boolean;
};

function runOne(
  label: string,
  pool: LeanPlayer[],
  compareBaseline: { OF: number; SP: number; RP: number } | null,
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
      ...(compareBaseline
        ? {
            OF_replacement_changed_vs_baseline:
              rOF != null ? Math.abs(rOF - compareBaseline.OF) > 1e-6 : undefined,
            SP_replacement_changed_vs_baseline:
              rSP != null ? Math.abs(rSP - compareBaseline.SP) > 1e-6 : undefined,
            RP_replacement_changed_vs_baseline:
              rRP != null ? Math.abs(rRP - compareBaseline.RP) > 1e-6 : undefined,
          }
        : {}),
    };
  } finally {
    unpatch();
  }
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

  const snapZ = {
    zScale: ROTO_Z_PITCHER.zScale,
    zLo: ROTO_Z_PITCHER.zLo,
    zHi: ROTO_Z_PITCHER.zHi,
  };
  const snapIntr = ROTO_INTRINSIC_BASE_PITCHER_REF.value;
  const snapRepl = { ...SLOT_REPLACEMENT_PERCENTILE };

  const restoreZ = () => {
    Object.assign(ROTO_Z_PITCHER, snapZ);
  };
  const restoreIntr = () => {
    ROTO_INTRINSIC_BASE_PITCHER_REF.value = snapIntr;
  };
  const restoreRepl = () => {
    Object.assign(SLOT_REPLACEMENT_PERCENTILE, snapRepl);
  };

  const noop = () => {};
  const baselineRow = runOne("baseline", pool, null, noop, noop);
  const baselineRepl = {
    OF: baselineRow.replacement_OF ?? -1,
    SP: baselineRow.replacement_SP ?? -1,
    RP: baselineRow.replacement_RP ?? -1,
  };

  const experiments: ExpResult[] = [
    baselineRow,
    ...([0.05, 0.1, 0.15, 0.2] as const).map((pct) =>
      runOne(
        `pitcher_zScale_plus_${Math.round(pct * 100)}pct`,
        pool,
        baselineRepl,
        () => {
          Object.assign(ROTO_Z_PITCHER, { zScale: snapZ.zScale * (1 + pct) });
        },
        restoreZ
      )
    ),
    ...([0.05, 0.1] as const).map((d) =>
      runOne(
        `pitcher_zHi_plus_${d.toFixed(2).replace(/\./g, "p")}`,
        pool,
        baselineRepl,
        () => {
          Object.assign(ROTO_Z_PITCHER, { zHi: snapZ.zHi + d });
        },
        restoreZ
      )
    ),
    ...([1, 2, 3] as const).map((d) =>
      runOne(
        `pitcher_intrinsic_base_plus_${d}`,
        pool,
        baselineRepl,
        () => {
          ROTO_INTRINSIC_BASE_PITCHER_REF.value = snapIntr + d;
        },
        restoreIntr
      )
    ),
    runOne(
      "combined_zScale_plus5pct_intrinsic_plus1",
      pool,
      baselineRepl,
      () => {
        Object.assign(ROTO_Z_PITCHER, { zScale: snapZ.zScale * 1.05 });
        ROTO_INTRINSIC_BASE_PITCHER_REF.value = snapIntr + 1;
      },
      () => {
        restoreZ();
        restoreIntr();
      }
    ),
    ...([0.03, 0.05, 0.08] as const).map((d) =>
      runOne(
        `OF_repl_percentile_plus_${String(d).replace(".", "p")}`,
        pool,
        baselineRepl,
        () => {
          Object.assign(SLOT_REPLACEMENT_PERCENTILE, { OF: snapRepl.OF + d });
        },
        restoreRepl
      )
    ),
    ...([0.1, 0.15, 0.2] as const).map((d) =>
      runOne(
        `SP_RP_repl_percentile_plus_${String(d).replace(".", "p")}`,
        pool,
        baselineRepl,
        () => {
          Object.assign(SLOT_REPLACEMENT_PERCENTILE, {
            SP: snapRepl.SP + d,
            RP: snapRepl.RP + d,
          });
        },
        restoreRepl
      )
    ),
  ];

  /* Formula traces: same top OF hitter & top pitcher IDs as baseline run */
  const inputBase = buildDraftroomStandardValuationInput({
    explain_valuation_rows: true,
    inflation_model: "replacement_slots_v2",
    deterministic: true,
    seed: 42,
  });
  const wfBase = executeValuationWorkflow(pool, inputBase, {});
  if (!wfBase.ok) throw new Error(wfBase.issues.join("; "));
  const ovBase = positionOverridesFromRequest(inputBase.position_overrides);
  const byIdBase = new Map(pool.map((p) => [getPlayerId(p), p]));

  const sortedBase = [...wfBase.response.valuations].sort(
    (a, b) => num(b.auction_value) - num(a.auction_value)
  );
  const hittersBase = sortedBase.filter((r) => {
    const lp = byIdBase.get(r.player_id);
    return lp && !isPitcherForBaseline(lp, ovBase);
  });
  const pitchersBase = sortedBase.filter((r) => {
    const lp = byIdBase.get(r.player_id);
    return lp && isPitcherForBaseline(lp, ovBase);
  });

  const topOfHitter =
    hittersBase.find((r) => {
      const pos = (r.position ?? "").toUpperCase();
      return (
        pos.includes("OF") ||
        pos.includes("LF") ||
        pos.includes("CF") ||
        pos.includes("RF")
      );
    }) ?? hittersBase[0];

  const topPitcherBase = pitchersBase[0];

  /** Pick best candidate toward targets without absurdities */
  const targets = {
    hitterLo: 0.65,
    hitterHi: 0.72,
    topPitcherMin: 24,
    budgetOk: { lo: 0.985, hi: 1.015 },
  };

  type ScoreRow = ExpResult & { score: number; notes: string };
  const scored: ScoreRow[] = experiments
    .filter((e) => e.ok && e.hitter_share_auction != null)
    .map((e) => {
      const hs = e.hitter_share_auction!;
      const tp = e.top_pitcher?.auction_value ?? 0;
      const br = e.budget_ratio ?? 0;
      const topH = e.top_hitter?.auction_value ?? 0;
      let score = 0;
      let notes = "";
      if (hs >= targets.hitterLo && hs <= targets.hitterHi) score += 100;
      else score -= Math.abs(hs - 0.685) * 200;
      if (tp >= targets.topPitcherMin) score += 80;
      else score -= (targets.topPitcherMin - tp) * 3;
      if (br >= targets.budgetOk.lo && br <= targets.budgetOk.hi) score += 40;
      else score -= Math.abs(br - 1) * 500;
      const baselineTopH = baselineRow.top_hitter?.auction_value ?? 0;
      if (baselineTopH > 0 && topH < baselineTopH * 0.82) {
        score -= 120;
        notes += "top_hitter_collapse;";
      }
      if (tp > 45) {
        score -= 60;
        notes += "pitcher_star_inflated;";
      }
      return { ...e, score, notes };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  let afterTrace: { top_of_hitter: unknown; top_pitcher: unknown } | null = null;
  if (best && topOfHitter && topPitcherBase) {
    const pidOf = topOfHitter.player_id;
    const pidP = topPitcherBase.player_id;

    const applyBestPatch = () => {
      restoreZ();
      restoreIntr();
      restoreRepl();
      if (best.label === "baseline") return;
      if (best.label.startsWith("pitcher_zScale_plus_")) {
        const m = best.label.match(/plus_(\d+)pct/);
        const pct = m ? Number(m[1]) / 100 : 0;
        Object.assign(ROTO_Z_PITCHER, { zScale: snapZ.zScale * (1 + pct) });
        return;
      }
      if (best.label.startsWith("pitcher_zHi_plus_")) {
        const rest = best.label.slice("pitcher_zHi_plus_".length);
        const d = Number(rest.replace(/p/g, "."));
        if (Number.isFinite(d)) Object.assign(ROTO_Z_PITCHER, { zHi: snapZ.zHi + d });
        return;
      }
      if (best.label.startsWith("pitcher_intrinsic_base_plus_")) {
        const d = Number(best.label.split("_").pop());
        if (Number.isFinite(d)) ROTO_INTRINSIC_BASE_PITCHER_REF.value = snapIntr + d;
        return;
      }
      if (best.label === "combined_zScale_plus5pct_intrinsic_plus1") {
        Object.assign(ROTO_Z_PITCHER, { zScale: snapZ.zScale * 1.05 });
        ROTO_INTRINSIC_BASE_PITCHER_REF.value = snapIntr + 1;
        return;
      }
      if (best.label.startsWith("OF_repl_percentile_plus_")) {
        const rest = best.label.slice("OF_repl_percentile_plus_".length);
        const d = Number(rest.replace(/p/g, "."));
        if (Number.isFinite(d))
          Object.assign(SLOT_REPLACEMENT_PERCENTILE, { OF: snapRepl.OF + d });
        return;
      }
      if (best.label.startsWith("SP_RP_repl_percentile_plus_")) {
        const rest = best.label.slice("SP_RP_repl_percentile_plus_".length);
        const d = Number(rest.replace(/p/g, "."));
        if (Number.isFinite(d))
          Object.assign(SLOT_REPLACEMENT_PERCENTILE, {
            SP: snapRepl.SP + d,
            RP: snapRepl.RP + d,
          });
      }
    };

    applyBestPatch();
    try {
      const wfAfter = executeValuationWorkflow(pool, inputBase, {});
      if (wfAfter.ok) {
        const rowOf = wfAfter.response.valuations.find((v) => v.player_id === pidOf);
        const rowP = wfAfter.response.valuations.find((v) => v.player_id === pidP);
        afterTrace = {
          top_of_hitter: traceRow("after_best", rowOf),
          top_pitcher: traceRow("after_best", rowP),
        };
      }
    } finally {
      restoreZ();
      restoreIntr();
      restoreRepl();
    }
  }

  const beforeTrace = {
    top_of_hitter: traceRow("baseline", topOfHitter),
    top_pitcher: traceRow("baseline", topPitcherBase),
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    catalog_rows: pool.length,
    baseline_snapshots: {
      ROTO_Z_PITCHER: { ...snapZ },
      ROTO_INTRINSIC_BASE_PITCHER: snapIntr,
      SLOT_REPLACEMENT_PERCENTILE: { ...snapRepl },
      baseline_replacement: baselineRepl,
    },
    targets_note:
      "Desired band (informative): hitter share ~65–72%, pitcher ~28–35%, top pitcher mid-$20s+, budget ratio ~1.0, avoid collapsing hitter stars.",
    experiments,
    ranked_by_heuristic_score: scored.map((s) => ({
      label: s.label,
      score: s.score,
      notes: s.notes || undefined,
      hitter_share_auction: s.hitter_share_auction,
      pitcher_share_auction: s.pitcher_share_auction,
      top_pitcher_auction: s.top_pitcher?.auction_value,
      budget_ratio: s.budget_ratio,
    })),
    formula_trace: {
      baseline_ids: {
        top_of_hitter_id: topOfHitter?.player_id,
        top_pitcher_id: topPitcherBase?.player_id,
      },
      before: beforeTrace,
      after_best: afterTrace,
      best_label: best?.label ?? null,
    },
    recommendation:
      "See assistant narrative: pick highest-scoring row that meets targets; if none, intrinsic+zScale combos or SP/RP percentile shifts warrant production consideration.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ wrote: OUT, experiments: experiments.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
