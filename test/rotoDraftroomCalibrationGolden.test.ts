/**
 * Golden ranges for Draftroom-default roster + synthetic catalog after roto Z
 * tuning (`baselineRotoZConfig.ts`) and intrinsic bases (`baselineValueEngine.ts`).
 * Keeps replacement_slots_v2 budget conservation (~sum top draftable ≈ league budget) stable.
 */
import { describe, expect, it } from "vitest";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import {
  buildDraftroomStandardValuationInput,
  buildSyntheticCalibrationDraftroomPool,
} from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput, ValuationResponse, ValuedPlayer } from "../src/types/brain";

function poolById(pool: LeanPlayer[]): Map<string, LeanPlayer> {
  const m = new Map<string, LeanPlayer>();
  for (const p of pool) {
    const id = p.mlbId != null ? String(p.mlbId) : String(p._id);
    m.set(id, p);
  }
  return m;
}

function classifyRow(
  row: ValuedPlayer,
  byId: Map<string, LeanPlayer>
): "hitter" | "pitcher" {
  const lp = byId.get(row.player_id);
  if (lp) {
    return isPitcherForBaseline(lp, undefined) ? "pitcher" : "hitter";
  }
  const pos = (row.position ?? "").toUpperCase();
  if (pos.includes("SP") || pos.includes("RP") || pos === "P") return "pitcher";
  return "hitter";
}

function metricsFor(
  res: ValuationResponse,
  input: NormalizedValuationInput,
  pool: LeanPlayer[]
) {
  const rows = res.valuations;
  const sorted = [...rows].sort((a, b) => b.auction_value - a.auction_value);
  const top = sorted[0]!;
  const leagueBudget = input.total_budget * input.num_teams;
  const dps = res.draftable_pool_size ?? 0;
  const sumTop =
    dps > 0 ? sorted.slice(0, dps).reduce((s, r) => s + r.auction_value, 0) : 0;
  const ratioDraftable = leagueBudget > 0 ? sumTop / leagueBudget : 0;
  const ge = (t: number) => rows.filter((r) => r.auction_value >= t).length;
  const nearOne = rows.filter((r) => r.auction_value <= 1.05).length;
  const byId = poolById(pool);
  let hit = 0;
  let pit = 0;
  for (const r of rows) {
    if (classifyRow(r, byId) === "hitter") hit += r.auction_value;
    else pit += r.auction_value;
  }
  const hp = hit + pit;
  return {
    topAuction: top.auction_value,
    topPlayerId: top.player_id,
    ge50: ge(50),
    ge40: ge(40),
    ge30: ge(30),
    ge20: ge(20),
    ge10: ge(10),
    nearOne,
    hitterShare: hp > 0 ? hit / hp : 0,
    pitcherShare: hp > 0 ? pit / hp : 0,
    ratioDraftable,
    draftablePoolSize: dps,
  };
}

describe("Draftroom synthetic calibration (golden ranges)", () => {
  it("standard_12_mixed shape: budget conservation + star tail + plausible hit/pitch split", () => {
    const pool = buildSyntheticCalibrationDraftroomPool();
    const input = buildDraftroomStandardValuationInput();
    const out = executeValuationWorkflow(pool, input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const m = metricsFor(out.response, input, pool);

    expect(m.ratioDraftable).toBeGreaterThanOrEqual(0.988);
    expect(m.ratioDraftable).toBeLessThanOrEqual(1.005);
    // Greedy v2 draftable count can sit slightly below full league capacity on the synthetic pool.
    expect(m.draftablePoolSize).toBeGreaterThanOrEqual(240);
    expect(m.draftablePoolSize).toBeLessThanOrEqual(252);

    // Synthetic pool: SP-heavy top; ranges tolerate small engine drift (24/23 pitcher intrinsic).
    expect(m.topAuction).toBeGreaterThanOrEqual(62);
    expect(m.topAuction).toBeLessThanOrEqual(80);

    expect(m.ge50).toBeGreaterThanOrEqual(10);
    expect(m.ge40).toBeGreaterThanOrEqual(18);
    expect(m.ge30).toBeGreaterThanOrEqual(22);

    // Synthetic pool stays SP-top-heavy; pitcher intrinsic + zHi bump shifts dollar share toward arms.
    expect(m.hitterShare).toBeGreaterThanOrEqual(0.33);
    expect(m.hitterShare).toBeLessThanOrEqual(0.42);

    expect(m.pitcherShare).toBeGreaterThanOrEqual(0.58);
    expect(m.pitcherShare).toBeLessThanOrEqual(0.68);
  });
});
