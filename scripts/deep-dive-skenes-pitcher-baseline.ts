/**
 * Read-only deep dive: Paul Skenes pitcher roto baseline trace + scenario experiments.
 * Does not modify Engine formulas (diagnostic + alternate z-pool math in-process only).
 *
 * MONGO_URI=... pnpm exec ts-node --project tsconfig.scripts.json scripts/deep-dive-skenes-pitcher-baseline.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import {
  buildDraftroomStandardValuationInput,
  CALIBRATION_CATS_5X5,
  CALIBRATION_CATS_QS_REPLACES_W,
  CALIBRATION_CATS_SAVES_ONLY,
} from "../src/lib/calibrationDraftroomFixture";
import {
  categoryRawValue,
  categoryWeight,
  categoryDirection,
  getProjectionSection,
  mean,
  stdDev,
} from "../src/services/baselineProjectionStats";
import { fitsRosterSlot, playerTokensFromLean } from "../src/lib/fantasyRosterSlots";
import {
  isPitcherForBaseline,
  isTwoWayEligibleForBaseline,
} from "../src/services/baselineProjectionStats";
import { ROTO_Z_PITCHER } from "../src/services/baselineRotoZConfig";
import { ROTO_INTRINSIC_BASE_PITCHER_REF } from "../src/services/baselineValueEngine";
import { catalogValuePrior } from "../src/lib/catalogValuePrior";
import { draftroomUiDefaultRoster } from "../src/lib/calibrationDraftroomFixture";
import type { LeanPlayer, ScoringCategory, ValuedPlayer } from "../src/types/brain";

const ROTO_CATALOG_PRIOR_WEIGHT = 0.12;
const SKENES_ID = "694973";

const pitchCats5x5 = CALIBRATION_CATS_5X5.filter((c) => c.type === "pitching");

function scarcityMultiplierForPositionLocal(p: LeanPlayer): number {
  const rosterSlots = draftroomUiDefaultRoster();
  const tokens = playerTokensFromLean(p, undefined);
  let demand = 1;
  for (const slot of rosterSlots) {
    const key = slot.position.toUpperCase().trim();
    if (key === "BN" || key.length === 0) continue;
    if (fitsRosterSlot(key, tokens)) demand = Math.max(demand, slot.count);
  }
  return Number(Math.min(1.25, 1 + (demand - 1) * 0.05).toFixed(4));
}

function poolById(pool: LeanPlayer[]): Map<string, LeanPlayer> {
  const m = new Map<string, LeanPlayer>();
  for (const p of pool) m.set(String(p.mlbId ?? p._id), p);
  return m;
}

function enginePitcherPool(players: LeanPlayer[]): LeanPlayer[] {
  return players.filter(
    (p) => isPitcherForBaseline(p, undefined) || isTwoWayEligibleForBaseline(p, undefined)
  );
}

function isSpOnlyTokens(p: LeanPlayer): boolean {
  const t = playerTokensFromLean(p, undefined);
  return t.includes("SP") && !t.includes("RP");
}

function isRpToken(p: LeanPlayer): boolean {
  return playerTokensFromLean(p, undefined).includes("RP");
}

type CatTrace = {
  category: string;
  raw: number;
  pool_mean: number;
  pool_stdev: number;
  z_before_direction: number;
  z: number;
  weight: number;
  z_contribution: number;
};

function tracePitcherRoto(
  p: LeanPlayer,
  zGroup: LeanPlayer[],
  label: string
): {
  label: string;
  group_size: number;
  zWeighted: number;
  projectionMult: number;
  zScale: number;
  zLo: number;
  zHi: number;
  intrinsicBase: number;
  statCore: number;
  prior: number;
  blendedCore: number;
  scarcityMult: number;
  categories: CatTrace[];
} {
  const section = getProjectionSection(p, "pitching");
  const catStats = pitchCats5x5.map((cat) => {
    const vals = zGroup.map((x) => categoryRawValue(getProjectionSection(x, "pitching"), cat.name));
    return { cat, avg: mean(vals), stdev: stdDev(vals) };
  });
  const categories: CatTrace[] = [];
  let zWeighted = 0;
  for (const c of catStats) {
    const raw = categoryRawValue(section, c.cat.name);
    if (c.stdev <= 1e-9) continue;
    let z = (raw - c.avg) / c.stdev;
    const zBefore = z;
    if (categoryDirection(c.cat.name) === "lower") z = -z;
    const w = categoryWeight(c.cat.name);
    zWeighted += z * w;
    categories.push({
      category: c.cat.name,
      raw,
      pool_mean: c.avg,
      pool_stdev: c.stdev,
      z_before_direction: zBefore,
      z,
      weight: w,
      z_contribution: z * w,
    });
  }
  const projectionMult = Math.max(
    ROTO_Z_PITCHER.zLo,
    Math.min(ROTO_Z_PITCHER.zHi, 1 + zWeighted * ROTO_Z_PITCHER.zScale)
  );
  const intrinsicBase = ROTO_INTRINSIC_BASE_PITCHER_REF.value;
  const statCore = intrinsicBase * projectionMult;
  const prior = catalogValuePrior(p);
  const scarcityMult = scarcityMultiplierForPositionLocal(p);
  const blendedCore =
    statCore * (1 - ROTO_CATALOG_PRIOR_WEIGHT) + Math.max(0, prior) * ROTO_CATALOG_PRIOR_WEIGHT;
  return {
    label,
    group_size: zGroup.length,
    zWeighted,
    projectionMult,
    zScale: ROTO_Z_PITCHER.zScale,
    zLo: ROTO_Z_PITCHER.zLo,
    zHi: ROTO_Z_PITCHER.zHi,
    intrinsicBase,
    statCore,
    prior,
    blendedCore,
    scarcityMult,
    categories,
  };
}

function pitchingProjectionSummary(p: LeanPlayer): Record<string, unknown> {
  const s = getProjectionSection(p, "pitching") as Record<string, unknown>;
  const num = (v: unknown): number | string | null => {
    if (v == null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") return v;
    return String(v);
  };
  return {
    IP: num(s.innings ?? s.inningsPitched ?? s.ip),
    K: num(s.strikeouts),
    W: num(s.wins),
    SV: num(s.saves),
    QS: num(s.qualityStarts),
    ERA: num(s.era),
    WHIP: num(s.whip),
  };
}

function rowSummary(
  pool: LeanPlayer[],
  row: ValuedPlayer | undefined
): Record<string, unknown> | null {
  if (!row) return null;
  const lp = poolById(pool).get(row.player_id);
  return {
    player_id: row.player_id,
    name: row.name,
    position: row.position,
    effective_positions: lp ? playerTokensFromLean(lp, undefined) : [],
    ...pitchingProjectionSummary(lp!),
    projection_component: row.baseline_components?.projection_component,
    scarcity_component: row.baseline_components?.scarcity_component,
    baseline_value: row.baseline_value,
    auction_value: row.auction_value,
    replacement_key_used: row.debug_v2?.replacement_key_used,
    replacement_value_used: row.debug_v2?.replacement_value_used,
    surplus_basis: row.debug_v2?.surplus_basis,
  };
}

function experimentMetrics(
  pool: LeanPlayer[],
  res: ValuedPlayer[],
  skenesId: string
): {
  skenes: { baseline_value: number; auction_value: number } | null;
  top5_sp_baseline: Array<{ player_id: string; name: string; baseline_value: number }>;
  top5_rp_baseline: Array<{ player_id: string; name: string; baseline_value: number }>;
  hitter_pitcher_share: { hitter: number; pitcher: number } | null;
  ratio_sum_to_budget: number | null;
} {
  const byId = poolById(pool);
  const leagueBudget = 260 * 12;
  const sumAll = res.reduce((s, r) => s + r.auction_value, 0);
  let hit = 0;
  let pit = 0;
  for (const r of res) {
    const lp = byId.get(r.player_id);
    if (!lp) continue;
    if (isPitcherForBaseline(lp, undefined)) pit += r.auction_value;
    else hit += r.auction_value;
  }
  const hp = hit + pit;
  const pitchers = res.filter((r) => {
    const lp = byId.get(r.player_id);
    return lp && isPitcherForBaseline(lp, undefined);
  });
  const spSorted = [...pitchers]
    .filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && isSpOnlyTokens(lp);
    })
    .sort((a, b) => b.baseline_value - a.baseline_value);
  const rpSorted = [...pitchers]
    .filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && isRpToken(lp);
    })
    .sort((a, b) => b.baseline_value - a.baseline_value);
  const sk = res.find((r) => r.player_id === skenesId);
  return {
    skenes: sk ? { baseline_value: sk.baseline_value, auction_value: sk.auction_value } : null,
    top5_sp_baseline: spSorted.slice(0, 5).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      baseline_value: r.baseline_value,
    })),
    top5_rp_baseline: rpSorted.slice(0, 5).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      baseline_value: r.baseline_value,
    })),
    hitter_pitcher_share:
      hp > 0 ? { hitter: hit / hp, pitcher: pit / hp } : null,
    ratio_sum_to_budget: leagueBudget > 0 ? sumAll / leagueBudget : null,
  };
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

  const fullPitcherZPool = enginePitcherPool(pool);
  const spOnlyZPool = fullPitcherZPool.filter(isSpOnlyTokens);

  const skenesLp = pool.find((p) => String(p.mlbId) === SKENES_ID);
  if (!skenesLp) throw new Error("Skenes not in pool");

  const traceFull = tracePitcherRoto(skenesLp, fullPitcherZPool, "full_engine_pitcher_pool");
  const traceSpOnly = tracePitcherRoto(skenesLp, spOnlyZPool.length >= 5 ? spOnlyZPool : fullPitcherZPool, "sp_only_z_pool_hypothetical");

  const baseInput = () => ({
    ...buildDraftroomStandardValuationInput(),
    explain_valuation_rows: true,
  });

  const wfStd = executeValuationWorkflow(pool, baseInput(), {}, { debugSignals: true });
  if (!wfStd.ok) throw new Error(wfStd.issues.join("; "));
  const rowsStd = wfStd.response.valuations;
  const skenesRow = rowsStd.find((r) => r.player_id === SKENES_ID);

  const pitchersStd = rowsStd.filter((r) => {
    const lp = poolById(pool).get(r.player_id);
    return lp && isPitcherForBaseline(lp, undefined);
  });
  const spOnlyPitchers = pitchersStd
    .filter((r) => {
      const lp = poolById(pool).get(r.player_id);
      return lp && isSpOnlyTokens(lp);
    })
    .sort((a, b) => b.baseline_value - a.baseline_value);

  const top25SpTable = spOnlyPitchers.slice(0, 25).map((r) => {
    const lp = poolById(pool).get(r.player_id)!;
    return {
      ...rowSummary(pool, r),
      IP: pitchingProjectionSummary(lp).IP,
      K: pitchingProjectionSummary(lp).K,
      W: pitchingProjectionSummary(lp).W,
      SV: pitchingProjectionSummary(lp).SV,
      QS: pitchingProjectionSummary(lp).QS,
      ERA: pitchingProjectionSummary(lp).ERA,
      WHIP: pitchingProjectionSummary(lp).WHIP,
    };
  });

  const topBaselineAll = [...pitchersStd].sort((a, b) => b.baseline_value - a.baseline_value)[0];
  const topSpOnly = spOnlyPitchers[0];
  const topRp = [...pitchersStd]
    .filter((r) => {
      const lp = poolById(pool).get(r.player_id);
      return lp && isRpToken(lp);
    })
    .sort((a, b) => b.baseline_value - a.baseline_value)[0];
  const highIpAce = spOnlyPitchers.find((r) => {
    const lp = poolById(pool).get(r.player_id);
    if (!lp) return false;
    const ip = Number(pitchingProjectionSummary(lp).IP);
    return Number.isFinite(ip) && ip >= 160 && r.player_id !== SKENES_ID;
  });

  const experiments: {
    name: string;
    input: ReturnType<typeof buildDraftroomStandardValuationInput> & { explain_valuation_rows?: boolean };
  }[] = [
    { name: "standard_5x5", input: baseInput() },
    {
      name: "saves_only_pitching",
      input: { ...buildDraftroomStandardValuationInput(), scoring_categories: CALIBRATION_CATS_SAVES_ONLY },
    },
    {
      name: "qs_replaces_w",
      input: { ...buildDraftroomStandardValuationInput(), scoring_categories: CALIBRATION_CATS_QS_REPLACES_W },
    },
  ];

  const experimentResults: Record<string, unknown>[] = [];
  for (const ex of experiments) {
    const wf = executeValuationWorkflow(pool, ex.input, {}, { debugSignals: true });
    if (!wf.ok) {
      experimentResults.push({ name: ex.name, error: wf.issues });
      continue;
    }
    const top25Overall = [...wf.response.valuations]
      .sort((a, b) => b.auction_value - a.auction_value)
      .slice(0, 25)
      .map((r) => ({
        player_id: r.player_id,
        name: r.name,
        position: r.position,
        auction_value: r.auction_value,
        baseline_value: r.baseline_value,
      }));
    experimentResults.push({
      name: ex.name,
      metrics: experimentMetrics(pool, wf.response.valuations, SKENES_ID),
      top25_overall_by_auction: top25Overall,
    });
  }

  /** zWeighted if SV contribution forced to 0 (diagnostic — not Engine behavior). */
  let zWeightedNoSv = traceFull.zWeighted;
  const svRow = traceFull.categories.find((c) => c.category === "SV");
  if (svRow) zWeightedNoSv -= svRow.z_contribution;

  const multNoSv = Math.max(
    ROTO_Z_PITCHER.zLo,
    Math.min(ROTO_Z_PITCHER.zHi, 1 + zWeightedNoSv * ROTO_Z_PITCHER.zScale)
  );

  const out = {
    intro:
      "Pitcher roto uses ONE z-score pool: all `isPitcherForBaseline || twoWay` players. Category weights: ERA/WHIP=14, W/SV/K (and SB)=1 or 1.6 for W/SV — see baselineProjectionStats.categoryWeight. projectionMult = clamp(zLo,zHi, 1 + zWeighted*zScale).",
    skenes_trace_full_pitcher_pool: traceFull,
    skenes_trace_sp_only_z_pool_hypothetical: traceSpOnly,
    diagnostic_zWeighted_if_sv_contribution_removed: {
      zWeighted_original: traceFull.zWeighted,
      zWeighted_without_sv: zWeightedNoSv,
      projectionMult_without_sv: multNoSv,
      note: "Hypothetical only — Engine always uses full pitcher pool for z-stats.",
    },
    comparison_players: {
      top_baseline_any_pitcher: rowSummary(pool, topBaselineAll),
      top_baseline_sp_only: rowSummary(pool, topSpOnly),
      top_baseline_rp_token: rowSummary(pool, topRp),
      high_ip_ace_sp_sample: rowSummary(pool, highIpAce),
    },
    skenes_valuation_row_standard: rowSummary(pool, skenesRow),
    top25_sp_only_by_baseline_snapshot: top25SpTable,
    experiments: experimentResults,
    weights_reference: pitchCats5x5.map((c) => ({
      name: c.name,
      categoryWeight: categoryWeight(c.name),
    })),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
