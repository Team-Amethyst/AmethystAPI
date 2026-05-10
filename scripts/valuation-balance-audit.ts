/**
 * Post-cleanup valuation balance audit (read-only Mongo; optional in-memory config patches).
 *
 *   npx ts-node --project tsconfig.scripts.json scripts/valuation-balance-audit.ts
 *
 * Writes tmp/valuation-balance-audit.json — does not modify committed formulas.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import type { LeanPlayer, ValuationResponse, ValuedPlayer } from "../src/types/brain";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { getPlayerId } from "../src/lib/playerId";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { ROTO_Z_HITTER, ROTO_Z_PITCHER } from "../src/services/baselineRotoZConfig";
import { SLOT_REPLACEMENT_PERCENTILE } from "../src/services/replacementSlotsV2Config";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "valuation-balance-audit.json");

type RowDetail = {
  player_id: string;
  name?: string;
  position?: string;
  baseline_value: number;
  auction_value: number;
  surplus_basis: number | null;
  replacement_key_used: string | null;
  replacement_value_used: number | null;
  inflation_factor: number | null;
  recommended_bid: number | null;
  rec_minus_auction: number | null;
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[i]!;
}

function summarize(vals: number[]): {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  min: number;
  max: number;
} {
  if (vals.length === 0)
    return { n: 0, mean: 0, p50: 0, p90: 0, min: 0, max: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return {
    n: vals.length,
    mean,
    p50: pct(vals, 0.5),
    p90: pct(vals, 0.9),
    min: Math.min(...vals),
    max: Math.max(...vals),
  };
}

function countMap<T extends string>(keys: (T | null | undefined)[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const k of keys) {
    const kk = k ?? "null";
    m[kk] = (m[kk] ?? 0) + 1;
  }
  return m;
}

function extractRows(
  res: ValuationResponse,
  pool: LeanPlayer[]
): RowDetail[] {
  const byId = new Map<string, LeanPlayer>();
  for (const p of pool) byId.set(getPlayerId(p), p);
  const input = buildDraftroomStandardValuationInput();
  const ov = positionOverridesFromRequest(input.position_overrides);
  return res.valuations.map((r: ValuedPlayer) => {
    const lp = byId.get(r.player_id);
    const ex = r.valuation_explain;
    return {
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      baseline_value: r.baseline_value ?? 0,
      auction_value: r.auction_value ?? 0,
      surplus_basis: ex?.surplus_basis ?? null,
      replacement_key_used: ex?.replacement_key_used ?? null,
      replacement_value_used: ex?.replacement_value_used ?? null,
      inflation_factor: r.inflation_factor ?? null,
      recommended_bid: r.recommended_bid ?? null,
      rec_minus_auction:
        r.recommended_bid != null ? r.recommended_bid - r.auction_value : null,
    };
  });
}

function splitPitchHit(
  rows: RowDetail[],
  pool: LeanPlayer[],
  positionOverrides: ReturnType<typeof positionOverridesFromRequest>
): { hitters: RowDetail[]; pitchers: RowDetail[] } {
  const byId = new Map<string, LeanPlayer>();
  for (const p of pool) byId.set(getPlayerId(p), p);
  const hitters: RowDetail[] = [];
  const pitchers: RowDetail[] = [];
  for (const r of rows) {
    const lp = byId.get(r.player_id);
    if (!lp) continue;
    if (isPitcherForBaseline(lp, positionOverrides)) pitchers.push(r);
    else hitters.push(r);
  }
  return { hitters, pitchers };
}

function positionalMix(topN: RowDetail[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of topN) {
    const pos = (r.position ?? "UNK").trim().toUpperCase();
    m[pos] = (m[pos] ?? 0) + 1;
  }
  return m;
}

function thresholdCounts(rows: RowDetail[]): { ge40: number; ge30: number; ge20: number } {
  let ge40 = 0,
    ge30 = 0,
    ge20 = 0;
  for (const r of rows) {
    if (r.auction_value >= 40) ge40++;
    if (r.auction_value >= 30) ge30++;
    if (r.auction_value >= 20) ge20++;
  }
  return { ge40, ge30, ge20 };
}

function topN<T extends RowDetail>(rows: T[], key: keyof RowDetail, n: number): T[] {
  return [...rows]
    .sort((a, b) => num(b[key]) - num(a[key]))
    .slice(0, n) as T[];
}

function experimentRun(
  label: string,
  pool: LeanPlayer[],
  patch: () => void,
  unpatch: () => void
): Record<string, unknown> {
  patch();
  try {
    const input = buildDraftroomStandardValuationInput({
      explain_valuation_rows: true,
      inflation_model: "replacement_slots_v2",
      deterministic: true,
      seed: 42,
    });
    const wf = executeValuationWorkflow(pool, input, {});
    if (!wf.ok) return { label, ok: false, issues: wf.issues };
    const res = wf.response;
    const rows = extractRows(res, pool);
    const ov = positionOverridesFromRequest(input.position_overrides);
    const { hitters, pitchers } = splitPitchHit(rows, pool, ov);
    const leagueBudget = input.total_budget * input.num_teams;
    const sumAll = rows.reduce((s, r) => s + r.auction_value, 0);
    const hp = hitters.reduce((s, r) => s + r.auction_value, 0);
    const pp = pitchers.reduce((s, r) => s + r.auction_value, 0);
    const sortedAll = [...rows].sort((a, b) => b.auction_value - a.auction_value);
    const topAll = sortedAll[0];
    const topP = [...pitchers].sort((a, b) => b.auction_value - a.auction_value)[0];
    const rbGaps = rows
      .map((r) => r.rec_minus_auction)
      .filter((x): x is number => x != null && Number.isFinite(x));
    const gapSummary = summarize(rbGaps.map(Math.abs));

    return {
      label,
      ok: true,
      pool_hitters: hitters.length,
      pool_pitchers: pitchers.length,
      hitter_share_auction: hp + pp > 0 ? hp / (hp + pp) : null,
      ratio_sum_to_budget: leagueBudget > 0 ? sumAll / leagueBudget : null,
      top_player: topAll
        ? {
            player_id: topAll.player_id,
            name: topAll.name,
            position: topAll.position,
            auction_value: topAll.auction_value,
            baseline_value: topAll.baseline_value,
          }
        : null,
      top_pitcher: topP
        ? {
            player_id: topP.player_id,
            name: topP.name,
            position: topP.position,
            auction_value: topP.auction_value,
            baseline_value: topP.baseline_value,
          }
        : null,
      top25_positional_mix: positionalMix(sortedAll.slice(0, 25)),
      threshold_auction: thresholdCounts(rows),
      recommended_bid_gap_abs: {
        n: gapSummary.n,
        mean: gapSummary.mean,
        p50: gapSummary.p50,
        p90: gapSummary.p90,
        materially_ge10: rbGaps.filter((x) => Math.abs(x) >= 10).length,
      },
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

  const snapZHit = { ...ROTO_Z_HITTER };
  const snapZPit = { ...ROTO_Z_PITCHER };
  const snapRepl = { ...SLOT_REPLACEMENT_PERCENTILE };

  const restoreZ = () => {
    Object.assign(ROTO_Z_HITTER, snapZHit);
    Object.assign(ROTO_Z_PITCHER, snapZPit);
  };
  const restoreRepl = () => {
    Object.assign(SLOT_REPLACEMENT_PERCENTILE, snapRepl);
  };

  const input = buildDraftroomStandardValuationInput({
    explain_valuation_rows: true,
    inflation_model: "replacement_slots_v2",
    deterministic: true,
    seed: 42,
  });
  const wf = executeValuationWorkflow(pool, input, {});
  if (!wf.ok) throw new Error(wf.issues.join("; "));
  const res = wf.response;
  const rows = extractRows(res, pool);
  const ov = positionOverridesFromRequest(input.position_overrides);
  const { hitters, pitchers } = splitPitchHit(rows, pool, ov);

  const mkSide = (label: string, side: RowDetail[]) => ({
    label,
    count: side.length,
    baseline_value: summarize(side.map((r) => r.baseline_value)),
    auction_value: summarize(side.map((r) => r.auction_value)),
    surplus_basis: summarize(
      side.map((r) => r.surplus_basis).filter((x): x is number => x != null)
    ),
    replacement_key_used: countMap(side.map((r) => r.replacement_key_used)),
    replacement_value_used: summarize(
      side.map((r) => r.replacement_value_used).filter((x): x is number => x != null)
    ),
    top25_by_baseline: topN(side, "baseline_value", 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      baseline_value: r.baseline_value,
      auction_value: r.auction_value,
      replacement_key_used: r.replacement_key_used,
      replacement_value_used: r.replacement_value_used,
      surplus_basis: r.surplus_basis,
      inflation_factor: r.inflation_factor,
    })),
    top25_by_auction: topN(side, "auction_value", 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      baseline_value: r.baseline_value,
      auction_value: r.auction_value,
      replacement_key_used: r.replacement_key_used,
      replacement_value_used: r.replacement_value_used,
      surplus_basis: r.surplus_basis,
      inflation_factor: r.inflation_factor,
    })),
  });

  const leagueBudget = input.total_budget * input.num_teams;
  const sumAll = rows.reduce((s, r) => s + r.auction_value, 0);
  const hp = hitters.reduce((s, r) => s + r.auction_value, 0);
  const pp = pitchers.reduce((s, r) => s + r.auction_value, 0);

  const replacement_table = res.replacement_values_by_slot_or_position ?? {};

  const sortedAll = [...rows].sort((a, b) => b.auction_value - a.auction_value);
  const pitcherTopBaseline = topN(pitchers, "baseline_value", 25);
  const pitcherTopAuction = topN(pitchers, "auction_value", 25);

  const ofRows = hitters.filter((r) =>
    ["LF", "CF", "RF", "OF"].includes((r.position ?? "").toUpperCase())
  );

  const experiments = [
    experimentRun(
      "A_current",
      pool,
      () => {},
      () => {}
    ),
    experimentRun(
      "B_pitcher_zscale_plus_12pct",
      pool,
      () => {
        Object.assign(ROTO_Z_PITCHER, { zScale: snapZPit.zScale * 1.12 });
      },
      restoreZ
    ),
    experimentRun(
      "C_hitter_zscale_minus_12pct",
      pool,
      () => {
        Object.assign(ROTO_Z_HITTER, { zScale: snapZHit.zScale * 0.88 });
      },
      restoreZ
    ),
    experimentRun(
      "D_SP_RP_repl_percentile_plus_05",
      pool,
      () => {
        Object.assign(SLOT_REPLACEMENT_PERCENTILE, {
          SP: snapRepl.SP + 0.05,
          RP: snapRepl.RP + 0.05,
        });
      },
      restoreRepl
    ),
    experimentRun(
      "E_OF_repl_percentile_minus_03",
      pool,
      () => {
        Object.assign(SLOT_REPLACEMENT_PERCENTILE, { OF: snapRepl.OF - 0.03 });
      },
      restoreRepl
    ),
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    catalog_pool_rows: pool.length,
    standard_mixed: {
      leagueBudget,
      sum_auction_all: sumAll,
      ratio_sum_to_budget: sumAll / leagueBudget,
      hitter_share: hp / (hp + pp),
      pitcher_share: pp / (hp + pp),
      replacement_values_by_slot_or_position: replacement_table,
      hitters: mkSide("hitters", hitters),
      pitchers: mkSide("pitchers", pitchers),
      top25_overall_positional_mix: positionalMix(sortedAll.slice(0, 25)),
      of_rows_count: ofRows.length,
      pitcher_inspection: {
        top25_by_baseline_value: pitcherTopBaseline.map((r) => ({
          player_id: r.player_id,
          name: r.name,
          position: r.position,
          baseline_value: r.baseline_value,
          auction_value: r.auction_value,
          replacement_key_used: r.replacement_key_used,
          replacement_value_used: r.replacement_value_used,
          surplus_basis: r.surplus_basis,
          inflation_factor: r.inflation_factor,
        })),
        top25_by_auction_value: pitcherTopAuction.map((r) => ({
          player_id: r.player_id,
          name: r.name,
          position: r.position,
          baseline_value: r.baseline_value,
          auction_value: r.auction_value,
          replacement_key_used: r.replacement_key_used,
          replacement_value_used: r.replacement_value_used,
          surplus_basis: r.surplus_basis,
          inflation_factor: r.inflation_factor,
        })),
      },
    },
    pre_cleanup_reference_note:
      "Shipped targets in baselineRotoZConfig.ts comment: hitter share ~69%, top pitcher ~$24 (Jan 2026 sweep). Compare current mixed share to that benchmark — drift often reflects catalog projection distribution, not only constants.",
    experiments,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ wrote: OUT, catalog_rows: pool.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
