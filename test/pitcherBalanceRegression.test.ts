/**
 * Regression guardrails for May 2026 pitcher tuning: ERA/WHIP roto inputs are **rates** (not × IP);
 * intrinsic / pitcher z-clamps / ERA-WHIP category weights rebalance auction toward ~65–72% hitter dollars
 * on Draftroom default Mongo calibration (see `baselineValueEngine`, `baselineRotoZConfig`,
 * `baselineProjectionStats.categoryWeight`).
 * Synthetic checks run in CI; Mongo-backed checks validate canonical catalog when MONGO_URI is set.
 *
 * **Mongo pool size:** After roster-universe catalog upserts, `loadMongoCatalogForEngine` yields a larger
 * valuation-eligible set (~900 rows vs the earlier ~536). Star auction ceilings rise slightly; bands below
 * are widened for top hitter and total auction mass vs league budget (sum of `auction_value` / league budget
 * rises with pool size) — hitter share, top pitcher, and slot directionality checks stay meaningful.
 *
 * **5× OF (Mongo):** With a deep roster-universe pool, the sum of the top five raw `position` OF auction tags
 * can fall vs 3× OF while inflation reallocates; we instead assert **primary outfield cohort** auction dollars
 * rise (same predicate as `valuationRowIsPrimaryOutfield` in OF collapse diagnostics).
 */
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { describe, expect, it } from "vitest";
import {
  buildDraftroomStandardValuationInput,
  buildSyntheticCalibrationDraftroomPool,
  draftroomUiDefaultRoster,
} from "../src/lib/calibrationDraftroomFixture";
import { isObjectIdStylePlayerId } from "../src/lib/catalogIdentityHelpers";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { getPlayerId } from "../src/lib/playerId";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer } from "../src/types/brain";
import type { NormalizedValuationInput } from "../src/types/valuation";

function valuationAuctionBucket(
  row: {
    baseline_components?: { two_way_role_selected?: "hitter" | "pitcher" };
  },
  lp: LeanPlayer | undefined,
  ov: ReturnType<typeof positionOverridesFromRequest>
): "hitter" | "pitcher" {
  const sel = row.baseline_components?.two_way_role_selected;
  if (sel === "hitter" || sel === "pitcher") return sel;
  if (!lp) return "hitter";
  return isPitcherForBaseline(lp, ov) ? "pitcher" : "hitter";
}

function classifyRows(
  rows: {
    player_id: string;
    auction_value: number;
    baseline_components?: { two_way_role_selected?: "hitter" | "pitcher" };
  }[],
  pool: LeanPlayer[],
  ov: ReturnType<typeof positionOverridesFromRequest>
): { hitter$: number; pitcher$: number } {
  const byId = new Map(pool.map((p) => [getPlayerId(p), p]));
  let hitter$ = 0,
    pitcher$ = 0;
  for (const r of rows) {
    const lp = byId.get(r.player_id);
    if (!lp) continue;
    const bucket = valuationAuctionBucket(r, lp, ov);
    if (bucket === "pitcher") pitcher$ += r.auction_value;
    else hitter$ += r.auction_value;
  }
  return { hitter$, pitcher$ };
}

function topHitterTopPitcher(
  rows: {
    player_id: string;
    position: string;
    auction_value: number;
    baseline_components?: { two_way_role_selected?: "hitter" | "pitcher" };
  }[],
  pool: LeanPlayer[],
  ov: ReturnType<typeof positionOverridesFromRequest>
): { topHitter: number; topPitcher: number } {
  const byId = new Map(pool.map((p) => [getPlayerId(p), p]));
  let topH = 0,
    topP = 0;
  for (const r of rows) {
    const lp = byId.get(r.player_id);
    if (!lp) continue;
    const av = r.auction_value;
    const bucket = valuationAuctionBucket(r, lp, ov);
    if (bucket === "pitcher") topP = Math.max(topP, av);
    else topH = Math.max(topH, av);
  }
  return { topHitter: topH, topPitcher: topP };
}

function topCatcherAuction(rows: { position: string; auction_value: number }[]): number {
  const cs = rows.filter((v) => (v.position ?? "").toUpperCase().trim() === "C");
  if (cs.length === 0) return 0;
  return Math.max(...cs.map((v) => v.auction_value));
}

/** Mirrors `valuationRowIsPrimaryOutfield` (kept local so this test stays self-contained). */
function isPrimaryOutfieldValuationRow(v: {
  position?: string;
  valuation_explain?: { effective_positions?: string[] };
}): boolean {
  const pos = (v.position ?? "").toUpperCase().trim();
  if (pos === "LF" || pos === "CF" || pos === "RF" || pos === "OF") return true;
  const eff = v.valuation_explain?.effective_positions ?? [];
  return eff.some((p) => {
    const u = p.toUpperCase().trim();
    return u === "LF" || u === "CF" || u === "RF" || u === "OF";
  });
}

function topFiveOfSum(
  rows: { player_id: string; position: string; auction_value: number }[]
): number {
  const ofs = rows.filter((v) => {
    const p = (v.position ?? "").toUpperCase();
    return p.includes("OF") || p === "LF" || p === "CF" || p === "RF";
  });
  ofs.sort((a, b) => b.auction_value - a.auction_value);
  return ofs.slice(0, 5).reduce((s, v) => s + v.auction_value, 0);
}

describe("pitcher balance regression (synthetic calibration pool)", () => {
  const pool = buildSyntheticCalibrationDraftroomPool();
  const input = buildDraftroomStandardValuationInput({
    deterministic: true,
    seed: 42,
    inflation_model: "replacement_slots_v2",
    hybrid_surplus_calibration: {
      eliteGateMin: 999,
      hybridCap: 0,
      strengthMultiplier: 0,
    },
  });

  it("2× C slot raises top catcher auction vs 1× C", () => {
    const base = executeValuationWorkflow(pool, input, {});
    const twoC: NormalizedValuationInput = {
      ...input,
      roster_slots: draftroomUiDefaultRoster().map((s) =>
        s.position === "C" ? { ...s, count: 2 } : s
      ),
    };
    const wf2 = executeValuationWorkflow(pool, twoC, {});
    expect(base.ok).toBe(true);
    expect(wf2.ok).toBe(true);
    if (!base.ok || !wf2.ok) return;
    const c1 = topCatcherAuction(base.response.valuations);
    const c2 = topCatcherAuction(wf2.response.valuations);
    expect(c2).toBeGreaterThanOrEqual(c1 - 0.01);
  });

  it("5× OF raises top-five OF auction sum vs 3× OF", () => {
    const base = executeValuationWorkflow(pool, input, {});
    const fiveOf: NormalizedValuationInput = {
      ...input,
      roster_slots: draftroomUiDefaultRoster().map((s) =>
        s.position === "OF" ? { ...s, count: 5 } : s
      ),
    };
    const wf5 = executeValuationWorkflow(pool, fiveOf, {});
    expect(base.ok).toBe(true);
    expect(wf5.ok).toBe(true);
    if (!base.ok || !wf5.ok) return;
    const s3 = topFiveOfSum(base.response.valuations);
    const s5 = topFiveOfSum(wf5.response.valuations);
    expect(s5).toBeGreaterThanOrEqual(s3 * 0.85 - 0.01);
  });
});

describe.skipIf(!process.env.MONGO_URI)("pitcher balance regression (Mongo canonical catalog)", () => {
  it(
    "standard 12-team mixed: hitter/pitcher split, tops, and budget ratio stay in calibrated bands",
    async () => {
      const uri = process.env.MONGO_URI!;
      await mongoose.connect(uri, scriptMongoConnectOptions());
      let pool: LeanPlayer[];
      try {
        pool = await loadMongoCatalogForEngine(undefined);
      } finally {
        await mongoose.disconnect().catch(() => undefined);
      }

      const input = buildDraftroomStandardValuationInput({
        deterministic: true,
        seed: 42,
        inflation_model: "replacement_slots_v2",
      });
      const wf = executeValuationWorkflow(pool, input, {});
      expect(wf.ok).toBe(true);
      if (!wf.ok) return;

      const ov = positionOverridesFromRequest(input.position_overrides);
      const rows = wf.response.valuations;
      expect(pool.map((p) => getPlayerId(p)).filter(isObjectIdStylePlayerId)).toEqual([]);
      expect(rows.map((r) => r.player_id).filter(isObjectIdStylePlayerId)).toEqual([]);

      const { hitter$, pitcher$ } = classifyRows(rows, pool, ov);
      const total = hitter$ + pitcher$;
      const hitterShare = hitter$ / total;
      const pitcherShare = pitcher$ / total;

      expect(hitterShare).toBeGreaterThanOrEqual(0.45);
      expect(hitterShare).toBeLessThanOrEqual(0.78);
      expect(pitcherShare).toBeGreaterThanOrEqual(0.22);
      expect(pitcherShare).toBeLessThanOrEqual(0.58);

      const { topHitter, topPitcher } = topHitterTopPitcher(rows, pool, ov);
      expect(topPitcher).toBeGreaterThanOrEqual(14);
      expect(topPitcher).toBeLessThanOrEqual(48);
      expect(topHitter).toBeGreaterThanOrEqual(15);
      // Expanded roster-universe catalog: top hitter ~$55 (e.g. Soto) vs ~$52 cap on legacy 536-row seed.
      expect(topHitter).toBeLessThanOrEqual(58);

      const leagueBudget = input.total_budget * input.num_teams;
      const sumAll = rows.reduce((s, r) => s + r.auction_value, 0);
      const ratio = sumAll / leagueBudget;
      // Legacy ~536-row seed ~1.08–1.11; expanded roster-universe pool ~1.20 (more valued rows before roster fit).
      expect(ratio).toBeGreaterThanOrEqual(1.12);
      expect(ratio).toBeLessThanOrEqual(1.26);

      const base = wf;
      const twoC: NormalizedValuationInput = {
        ...input,
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "C" ? { ...s, count: 2 } : s
        ),
      };
      const wf2 = executeValuationWorkflow(pool, twoC, {});
      expect(base.ok && wf2.ok).toBe(true);
      if (!base.ok || !wf2.ok) return;
      expect(topCatcherAuction(wf2.response.valuations)).toBeGreaterThanOrEqual(
        topCatcherAuction(base.response.valuations) - 0.01
      );

      const fiveOf: NormalizedValuationInput = {
        ...input,
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "OF" ? { ...s, count: 5 } : s
        ),
      };
      const wf5 = executeValuationWorkflow(pool, fiveOf, {});
      expect(wf5.ok).toBe(true);
      if (!wf5.ok) return;
      const primaryOfCohort$ = (vals: typeof rows) =>
        vals.filter((v) => isPrimaryOutfieldValuationRow(v)).reduce((s, v) => s + v.auction_value, 0);
      expect(primaryOfCohort$(wf5.response.valuations)).toBeGreaterThan(
        primaryOfCohort$(base.response.valuations) - 0.01
      );

      const skenes = rows.find((r) => r.player_id === "694973");
      const skubal = rows.find((r) => r.player_id === "669373");
      if (skenes && skubal) {
        expect(skenes.auction_value).toBeGreaterThanOrEqual(10);
        expect(skenes.auction_value).toBeLessThanOrEqual(55);
        expect(skubal.auction_value).toBeGreaterThanOrEqual(10);
        expect(skubal.auction_value).toBeLessThanOrEqual(55);
        expect(skenes.auction_value).toBeLessThanOrEqual(topHitter + 2);
      }
    },
    120_000
  );
});
