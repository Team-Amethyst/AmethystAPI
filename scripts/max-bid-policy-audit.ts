/**
 * Max Bid / recommended_bid policy audit — writes tmp/max-bid-policy-audit.json
 *
 *   MONGO_URI=... npx ts-node --project tsconfig.scripts.json scripts/max-bid-policy-audit.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import type {
  DraftPhaseIndicator,
  DraftedPlayer,
  LeanPlayer,
  NormalizedValuationInput,
  ValuedPlayer,
} from "../src/types/brain";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import {
  buildDraftroomStandardValuationInput,
  CALIBRATION_CATS_5X5,
  CALIBRATION_CATS_SAVES_ONLY,
  draftroomUiDefaultRoster,
  legacyEngineCalibrationRoster,
} from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { getPlayerId } from "../src/lib/playerId";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { computeRecommendedBid } from "../src/services/recommendedBid";
import { buildLambdaForRow } from "../src/services/recommendedBidSteps";
import { compareByValueDesc } from "../src/services/valuationRows";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "max-bid-policy-audit.json");

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Snake draft order key: market ADP when present, else catalog_rank (lower = earlier pick). */
function draftPickOrderKey(p: LeanPlayer): number {
  const m = p.market_adp;
  if (typeof m === "number" && Number.isFinite(m) && m > 0) return m;
  return p.catalog_rank ?? 9999;
}

function snakeTeamIndex(pickIndex: number, numTeams: number): number {
  const round = Math.floor(pickIndex / numTeams);
  const pos = pickIndex % numTeams;
  return round % 2 === 0 ? pos : numTeams - 1 - pos;
}

function draftByAdpOrder(
  pool: LeanPlayer[],
  pickCount: number,
  numTeams: number,
  budgetPerTeam: number
): DraftedPlayer[] {
  const sorted = [...pool].sort(
    (a, b) => draftPickOrderKey(a) - draftPickOrderKey(b)
  );
  const drafted: DraftedPlayer[] = [];
  for (let i = 0; i < Math.min(pickCount, sorted.length); i++) {
    const p = sorted[i]!;
    const teamIdx = snakeTeamIndex(i, numTeams);
    const tid = `team_${teamIdx + 1}`;
    const cat = Number.isFinite(p.value) ? p.value! : 10;
    const paid = Math.max(1, Math.min(Math.round(cat * 0.22), Math.max(1, budgetPerTeam - 2)));
    drafted.push({
      player_id: getPlayerId(p),
      name: p.name,
      position: p.position,
      team: p.team ?? "",
      team_id: tid,
      paid,
    });
  }
  return drafted;
}

function buildKeeperDraft(pool: LeanPlayer[], numTeams: number): DraftedPlayer[] {
  const sorted = [...pool].sort(
    (a, b) => (a.catalog_rank ?? 9999) - (b.catalog_rank ?? 9999)
  );
  const out: DraftedPlayer[] = [];
  for (let i = 0; i < 36 && i < sorted.length; i++) {
    const p = sorted[i]!;
    const tid = `team_${(i % numTeams) + 1}`;
    const v = Number.isFinite(p.value) ? p.value! : 12;
    const cost = Math.min(55, Math.max(4, Math.round(v * 0.24)));
    out.push({
      player_id: getPlayerId(p),
      name: p.name,
      position: p.position,
      team: p.team ?? "",
      team_id: tid,
      is_keeper: true,
      keeper_cost: cost,
      paid: cost,
    });
  }
  return out;
}

function thinEligibleIds(pool: LeanPlayer[], n: number, seed: number): string[] {
  const ids = pool.map((p) => getPlayerId(p));
  let h = seed >>> 0;
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
    const j = Math.abs(h >>> 0) % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}

function gapStats(rows: ValuedPlayer[]): {
  mean_gap: number | null;
  median_gap: number | null;
  p90_gap: number | null;
  max_gap: number | null;
  min_gap: number | null;
  count_gt_av_plus_10: number;
  count_gt_av_plus_20: number;
  count_rb_gt_2x_av: number;
  count_rb_lt_av: number;
  n: number;
} {
  const gaps = rows
    .map((r) => num(r.recommended_bid) - num(r.auction_value))
    .filter(() => true);
  if (gaps.length === 0) {
    return {
      mean_gap: null,
      median_gap: null,
      p90_gap: null,
      max_gap: null,
      min_gap: null,
      count_gt_av_plus_10: 0,
      count_gt_av_plus_20: 0,
      count_rb_gt_2x_av: 0,
      count_rb_lt_av: 0,
      n: 0,
    };
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  let c10 = 0,
    c20 = 0,
    c2x = 0,
    clt = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const av = num(r.auction_value);
    const rb = num(r.recommended_bid);
    if (rb > av + 10) c10++;
    if (rb > av + 20) c20++;
    if (av > 0 && rb > 2 * av) c2x++;
    if (rb < av) clt++;
  }
  return {
    mean_gap: mean,
    median_gap: percentile(sorted, 0.5),
    p90_gap: percentile(sorted, 0.9),
    max_gap: sorted[sorted.length - 1]!,
    min_gap: sorted[0]!,
    count_gt_av_plus_10: c10,
    count_gt_av_plus_20: c20,
    count_rb_gt_2x_av: c2x,
    count_rb_lt_av: clt,
    n: gaps.length,
  };
}

function topIds(rows: ValuedPlayer[], by: "rb" | "av", k: number): string[] {
  const key = by === "rb" ? (r: ValuedPlayer) => num(r.recommended_bid) : (r: ValuedPlayer) => num(r.auction_value);
  return [...rows]
    .sort((a, b) => key(b) - key(a))
    .slice(0, k)
    .map((r) => r.player_id);
}

function overlap(a: string[], b: string[]): { overlap_count: number; ids: string[] } {
  const sb = new Set(b);
  const ids = a.filter((x) => sb.has(x));
  return { overlap_count: ids.length, ids };
}

type ScenarioDef = { id: string; build: () => NormalizedValuationInput };

function defineAuditScenarios(pool: LeanPlayer[]): ScenarioDef[] {
  const obpCats = CALIBRATION_CATS_5X5.map((c) =>
    c.name === "AVG" ? { name: "OBP", type: "batting" as const } : c
  );
  const thinIds = thinEligibleIds(pool, 120, 42);
  const base = (): NormalizedValuationInput =>
    buildDraftroomStandardValuationInput({
      explain_valuation_rows: true,
      deterministic: true,
      seed: 42,
      inflation_model: "replacement_slots_v2",
    });
  const budget = base().total_budget;
  return [
    { id: "draft_start", build: base },
    {
      id: "draft_25_picks",
      build: () => ({
        ...base(),
        drafted_players: draftByAdpOrder(pool, 25, 12, budget),
      }),
    },
    {
      id: "draft_75_picks",
      build: () => ({
        ...base(),
        drafted_players: draftByAdpOrder(pool, 75, 12, budget),
      }),
    },
    {
      id: "draft_150_picks",
      build: () => ({
        ...base(),
        drafted_players: draftByAdpOrder(pool, 150, 12, budget),
      }),
    },
    { id: "standard_mixed", build: base },
    {
      id: "two_catcher",
      build: () => ({
        ...base(),
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "C" ? { ...s, count: 2 } : s
        ),
      }),
    },
    {
      id: "five_outfielder",
      build: () => ({
        ...base(),
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "OF" ? { ...s, count: 5 } : s
        ),
      }),
    },
    {
      id: "generic_P_slots",
      build: () => ({ ...base(), roster_slots: legacyEngineCalibrationRoster() }),
    },
    {
      id: "saves_only",
      build: () => ({ ...base(), scoring_categories: CALIBRATION_CATS_SAVES_ONLY }),
    },
    {
      id: "OBP",
      build: () => ({ ...base(), scoring_categories: obpCats }),
    },
    { id: "AL_only", build: () => ({ ...base(), league_scope: "AL" }) },
    { id: "NL_only", build: () => ({ ...base(), league_scope: "NL" }) },
    {
      id: "keeper_spread",
      build: () => ({
        ...base(),
        drafted_players: buildKeeperDraft(pool, 12),
      }),
    },
    {
      id: "thin_eligible_pool",
      build: () => ({ ...base(), eligible_player_ids: thinIds }),
    },
  ];
}

function depthFracForPlayer(
  byValueRows: LeanPlayer[],
  playerId: string,
  opts?: { deterministic?: boolean; seed?: number }
): number {
  const baselineOrderForDepth = [...byValueRows].sort((a, b) =>
    compareByValueDesc(a, b, opts)
  );
  const depthN = baselineOrderForDepth.length;
  const idx = baselineOrderForDepth.findIndex((p) => getPlayerId(p) === playerId);
  if (idx < 0) return 0.5;
  return depthN > 1 ? idx / (depthN - 1) : 0;
}

/** Classify dominant driver of rb >> auction_value (heuristic). */
function classifyGapCause(row: ValuedPlayer, pre: number): string[] {
  const causes: string[] = [];
  const av = num(row.auction_value);
  const bl = num(row.baseline_value);
  if (bl > av * 1.25 && bl - av > 5) causes.push("high_baseline_vs_auction");
  if (row.valuation_explain?.two_way_role_selected) causes.push("two_way_behavior");
  const ex = row.valuation_explain;
  if (ex?.scoring_category_warnings?.length) causes.push("unsupported_or_partial_category");
  if (ex?.valuation_context_warnings?.length) causes.push("valuation_context_warning");
  if (pre > av * 1.2 && bl > av) causes.push("clearing_blend_elite_floors");
  return causes.length ? causes : ["policy_stack_default"];
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

  const scenarios = defineAuditScenarios(pool);
  const scenarioGapTable: Record<string, ReturnType<typeof gapStats>> = {};
  const scenarioExtras: Record<
    string,
    {
      phase_indicator: DraftPhaseIndicator | undefined;
      inflation_index_vs_opening_auction: number | undefined;
      top25_by_rec_bid: { player_id: string; name?: string; rb: number; av: number }[];
      top25_by_auction_value: { player_id: string; name?: string; rb: number; av: number }[];
      top25_overlap: ReturnType<typeof overlap>;
    }
  > = {};

  const stdInput = scenarios.find((s) => s.id === "standard_mixed")!.build();
  const wfStd = executeValuationWorkflow(pool, stdInput, {});
  if (!wfStd.ok) {
    throw new Error(wfStd.issues.join("; "));
  }

  for (const sc of scenarios) {
    const input = sc.build();
    const wf = executeValuationWorkflow(pool, input, {});
    if (!wf.ok || !wf.response) {
      scenarioGapTable[sc.id] = gapStats([]);
      continue;
    }
    const rows = wf.response.valuations;
    scenarioGapTable[sc.id] = gapStats(rows);
    const topRb = [...rows]
      .sort((a, b) => num(b.recommended_bid) - num(a.recommended_bid))
      .slice(0, 25)
      .map((r) => ({
        player_id: r.player_id,
        name: r.name,
        rb: num(r.recommended_bid),
        av: num(r.auction_value),
      }));
    const topAv = [...rows]
      .sort((a, b) => num(b.auction_value) - num(a.auction_value))
      .slice(0, 25)
      .map((r) => ({
        player_id: r.player_id,
        name: r.name,
        rb: num(r.recommended_bid),
        av: num(r.auction_value),
      }));
    scenarioExtras[sc.id] = {
      phase_indicator: wf.response.phase_indicator,
      inflation_index_vs_opening_auction: wf.response.inflation_index_vs_opening_auction,
      top25_by_rec_bid: topRb,
      top25_by_auction_value: topAv,
      top25_overlap: overlap(
        topIds(rows, "rb", 25),
        topIds(rows, "av", 25)
      ),
    };
  }

  const uncappedRows = new Map(wfStd.response.valuations.map((v) => [v.player_id, v]));

  const runSoftCap = (ratio: number | undefined) => {
    const input =
      ratio === undefined
        ? stdInput
        : { ...stdInput, recommended_bid_soft_cap_ratio: ratio };
    const wf = executeValuationWorkflow(pool, input, {});
    if (!wf.ok || !wf.response) return null;
    let clipped = 0;
    let avMismatches = 0;
    const samples: {
      player_id: string;
      uncapped_rb: number;
      capped_rb: number;
      auction_value: number;
    }[] = [];
    for (const r of wf.response.valuations) {
      const u = uncappedRows.get(r.player_id);
      if (!u) continue;
      const uncRb = num(u.recommended_bid);
      const capRb = num(r.recommended_bid);
      if (uncRb > capRb + 0.01) {
        clipped++;
        if (samples.length < 10) {
          samples.push({
            player_id: r.player_id,
            uncapped_rb: uncRb,
            capped_rb: capRb,
            auction_value: num(r.auction_value),
          });
        }
      }
      if (Math.abs(num(r.auction_value) - num(u.auction_value)) > 0.02) avMismatches++;
    }
    return {
      ratio: ratio ?? null,
      clipped_count: clipped,
      auction_value_mismatch_vs_uncapped: avMismatches,
      sample_clipped_players: samples,
    };
  };

  const softCapAudit = {
    omitted_ratio_reference: runSoftCap(undefined),
    ratio_1_05: runSoftCap(1.05),
    ratio_1_10: runSoftCap(1.1),
    ratio_1_25: runSoftCap(1.25),
    note:
      "omitted_ratio_reference should clip 0 vs itself; capped runs compare recommended_bid to uncapped reference map.",
  };

  /* Player walkthrough — standard_mixed, recompute pre-smoothing */
  const res = wfStd.response;
  const phase = res.phase_indicator ?? "early";
  const inflationIdx = res.inflation_index_vs_opening_auction;
  const sortOpts = {
    deterministic: stdInput.deterministic === true,
    seed: stdInput.seed,
  };
  const byValueSorted = [...pool].sort((a, b) => compareByValueDesc(a, b, sortOpts));
  const ov = positionOverridesFromRequest(stdInput.position_overrides);

  const pickEliteHitters = res.valuations
    .filter((r) => {
      const lp = pool.find((p) => getPlayerId(p) === r.player_id);
      return lp && !isPitcherForBaseline(lp, ov);
    })
    .sort((a, b) => num(b.auction_value) - num(a.auction_value))
    .slice(0, 5);

  const pickElitePitchers = res.valuations
    .filter((r) => {
      const lp = pool.find((p) => getPlayerId(p) === r.player_id);
      return lp && isPitcherForBaseline(lp, ov);
    })
    .sort((a, b) => num(b.auction_value) - num(a.auction_value))
    .slice(0, 5);

  const hitMid = res.valuations
    .filter((r) => {
      const lp = pool.find((p) => getPlayerId(p) === r.player_id);
      return lp && !isPitcherForBaseline(lp, ov);
    })
    .sort((a, b) => num(b.auction_value) - num(a.auction_value));
  const midHitters = hitMid.slice(
    Math.max(0, Math.floor(hitMid.length * 0.35)),
    Math.max(0, Math.floor(hitMid.length * 0.35) + 3)
  );

  const pitSorted = res.valuations
    .filter((r) => {
      const lp = pool.find((p) => getPlayerId(p) === r.player_id);
      return lp && isPitcherForBaseline(lp, ov);
    })
    .sort((a, b) => num(b.auction_value) - num(a.auction_value));
  const midPitchers = pitSorted.slice(
    Math.max(0, Math.floor(pitSorted.length * 0.35)),
    Math.max(0, Math.floor(pitSorted.length * 0.35) + 3)
  );

  const ohtani =
    res.valuations.find(
      (r) =>
        (r.name ?? "").toLowerCase().includes("ohtani") ||
        (r.name ?? "").toLowerCase().includes("shohei")
    ) ?? null;

  const gapSorted = [...res.valuations].sort(
    (a, b) =>
      num(b.recommended_bid) -
      num(b.auction_value) -
      (num(a.recommended_bid) - num(a.auction_value))
  );
  const largeGapPlayers = gapSorted.slice(0, 3);

  const walkthroughPlayers: ValuedPlayer[] = [
    ...pickEliteHitters,
    ...pickElitePitchers,
    ...midHitters,
    ...midPitchers,
    ...(ohtani ? [ohtani] : []),
    ...largeGapPlayers,
  ];
  const seen = new Set<string>();
  const uniqueWalk = walkthroughPlayers.filter((r) => {
    if (seen.has(r.player_id)) return false;
    seen.add(r.player_id);
    return true;
  });

  const playerRows = uniqueWalk.map((row) => {
    const df = depthFracForPlayer(byValueSorted, row.player_id, sortOpts);
    const pre = computeRecommendedBid({
      row,
      draftPhase: phase,
      depthFrac: df,
      inflationIndexVsOpeningAuction: inflationIdx,
      minAuctionBid: 1,
    });
    const L = buildLambdaForRow(row, phase, df);
    const post = num(row.recommended_bid);
    return {
      player_id: row.player_id,
      name: row.name,
      position: row.position,
      effective_positions: row.valuation_explain?.effective_positions ?? [],
      auction_value: num(row.auction_value),
      baseline_value: num(row.baseline_value),
      recommended_bid_post_smooth: post,
      pre_smoothing_bid: Number(pre.toFixed(2)),
      rb_minus_auction: Number((post - num(row.auction_value)).toFixed(2)),
      rb_minus_team_adj: Number((post - num(row.team_adjusted_value)).toFixed(2)),
      lambda_L: Number(L.toFixed(4)),
      phase_indicator: phase,
      depth_frac: Number(df.toFixed(4)),
      smoothing_delta: Number((post - pre).toFixed(2)),
      policy_steps_applied:
        "clearing a+L*(r-a); elite_anchor_boost?; late_squeeze?; hitter floors; global_depth_min; late_hitter_cap?; pitcher_hybrid_floor?; early_pitcher_cap?; hi_soft_cap; then isotonic smooth by baseline within hitters/pitchers",
      gap_classification: classifyGapCause(row, pre),
    };
  });

  /* Smoothing audit: full roster */
  let smoothRaise = 0,
    smoothLower = 0;
  for (const row of res.valuations) {
    const df = depthFracForPlayer(byValueSorted, row.player_id, sortOpts);
    const pre = computeRecommendedBid({
      row,
      draftPhase: phase,
      depthFrac: df,
      inflationIndexVsOpeningAuction: inflationIdx,
      minAuctionBid: 1,
    });
    const post = num(row.recommended_bid);
    if (post > pre + 0.02) smoothRaise++;
    if (post < pre - 0.02) smoothLower++;
  }

  const suspiciousTable = gapSorted.slice(0, 40).map((row) => ({
    player_id: row.player_id,
    name: row.name,
    position: row.position,
    auction_value: num(row.auction_value),
    baseline_value: num(row.baseline_value),
    recommended_bid: num(row.recommended_bid),
    gap: num(row.recommended_bid) - num(row.auction_value),
    classification: classifyGapCause(
      row,
      computeRecommendedBid({
        row,
        draftPhase: phase,
        depthFrac: depthFracForPlayer(byValueSorted, row.player_id, sortOpts),
        inflationIndexVsOpeningAuction: inflationIdx,
        minAuctionBid: 1,
      })
    ),
  }));

  const phaseCompare = {
    draft_start: scenarioGapTable["draft_start"],
    draft_75_picks: scenarioGapTable["draft_75_picks"],
    draft_150_picks: scenarioGapTable["draft_150_picks"],
    phases: {
      start: scenarioExtras["draft_start"]?.phase_indicator,
      at_75: scenarioExtras["draft_75_picks"]?.phase_indicator,
      at_150: scenarioExtras["draft_150_picks"]?.phase_indicator,
    },
  };

  const output = {
    generated_at: new Date().toISOString(),
    pool_players: pool.length,
    formula_summary: {
      clearing:
        "recommended_bid starts from initialClearingPrice(L,a,r) = a + L*(r-a) with a=adjusted_value (=auction_value), r=baseline_value",
      lambda:
        "L = baseLambdaClearingPrice(phase, depthFrac) damped for pitchers via RECOMMENDED_BID_TUNING.pitcher_lambda_damp",
      depth:
        "depthFrac = rank by baseline list strength among undrafted byValueRows / (n-1)",
      phase:
        "resolveDraftPhase from roster fill: early <33%, mid <67%, else late",
      post_clearing:
        "elite anchor boost, late squeeze, hitter floors, global depth min, late hitter cap, pitcher hybrid floor, early neutral pitcher cap, hi_soft_cap",
      smoothing:
        "smoothRecommendedBids: sort by baseline_value desc within hitters and pitchers separately; isotonicNonIncreasing on recommended_bid series",
      team_context:
        "team_adjusted_value applied after recommended_bid; does not rewrite recommended_bid",
    },
    scenario_gap_table: scenarioGapTable,
    scenario_top25_and_overlap: scenarioExtras,
    player_walkthrough: playerRows,
    smoothing_audit: {
      players_smoothing_raised_pre_to_post: smoothRaise,
      players_smoothing_lowered_pre_to_post: smoothLower,
      note:
        "Isotonic regression pools adjacent violations — can raise lower-baseline players and lower higher-baseline players within a position group.",
    },
    phase_behavior: phaseCompare,
    soft_cap_audit: softCapAudit,
    suspicious_max_bid_table: suspiciousTable,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
