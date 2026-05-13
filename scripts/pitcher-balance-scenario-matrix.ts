/**
 * Scenario-matrix validation: shipped baseline vs candidate (intrinsic +3, pitcher zHi +0.10).
 *
 *   MONGO_URI=... npx ts-node --project tsconfig.scripts.json scripts/pitcher-balance-scenario-matrix.ts
 *
 * Writes tmp/pitcher-balance-scenario-matrix.json
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import type { DraftedPlayer, LeanPlayer, NormalizedValuationInput, ValuedPlayer } from "../src/types/brain";
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
import { ROTO_Z_HITTER, ROTO_Z_PITCHER } from "../src/services/baselineRotoZConfig";
import { ROTO_INTRINSIC_BASE_PITCHER_REF } from "../src/services/baselineValueEngine";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "pitcher-balance-scenario-matrix.json");

type Snap = {
  intr: number;
  zh: { zScale: number; zLo: number; zHi: number };
  zp: { zScale: number; zLo: number; zHi: number };
};

function restoreShipped(s: Snap): void {
  ROTO_INTRINSIC_BASE_PITCHER_REF.value = s.intr;
  Object.assign(ROTO_Z_HITTER, s.zh);
  Object.assign(ROTO_Z_PITCHER, s.zp);
}

function applyCandidate(s: Snap): void {
  restoreShipped(s);
  ROTO_INTRINSIC_BASE_PITCHER_REF.value = s.intr + 3;
  Object.assign(ROTO_Z_PITCHER, { zHi: s.zp.zHi + 0.1 });
}

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

function snakeTeamIndex(pickIndex: number, numTeams: number): number {
  const round = Math.floor(pickIndex / numTeams);
  const pos = pickIndex % numTeams;
  return round % 2 === 0 ? pos : numTeams - 1 - pos;
}

/** Deterministic ADP-order snake draft for checkpoint scenarios */
function draftByAdpOrder(
  pool: LeanPlayer[],
  pickCount: number,
  numTeams: number,
  budgetPerTeam: number
): DraftedPlayer[] {
  const sorted = [...pool]
    .filter((p) => (p.adp ?? 0) > 0)
    .sort((a, b) => (a.adp ?? 9999) - (b.adp ?? 9999));
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

function topCatcherAuction(rows: ValuedPlayer[]): number {
  const cs = rows.filter((v) => (v.position ?? "").toUpperCase().trim() === "C");
  if (cs.length === 0) return 0;
  return Math.max(...cs.map((v) => v.auction_value));
}

function topKOfSum(rows: ValuedPlayer[], k: number): number {
  const ofs = rows.filter((v) => {
    const p = (v.position ?? "").toUpperCase();
    return p.includes("OF") || p === "LF" || p === "CF" || p === "RF";
  });
  ofs.sort((a, b) => b.auction_value - a.auction_value);
  return ofs.slice(0, k).reduce((s, v) => s + v.auction_value, 0);
}

function rpCloserSum(rows: ValuedPlayer[], pool: LeanPlayer[], ov: ReturnType<typeof positionOverridesFromRequest>): number {
  let s = 0;
  const byId = new Map(pool.map((p) => [getPlayerId(p), p]));
  for (const r of rows) {
    const lp = byId.get(r.player_id);
    if (!lp) continue;
    if (!isPitcherForBaseline(lp, ov)) continue;
    const pos = (lp.position ?? "").toUpperCase();
    if (pos.includes("RP") || r.position?.toUpperCase().includes("RP")) s += r.auction_value;
  }
  return s;
}

function traceRow(v: ValuedPlayer | undefined): Record<string, unknown> | null {
  if (!v) return null;
  const ex = v.valuation_explain;
  return {
    player_id: v.player_id,
    name: v.name,
    position: v.position,
    baseline_value: v.baseline_value,
    auction_value: v.auction_value,
    inflation_factor: v.inflation_factor,
    valuation_explain: ex
      ? {
          replacement_key_used: ex.replacement_key_used,
          replacement_value_used: ex.replacement_value_used,
          surplus_basis: ex.surplus_basis,
          inflation_factor: ex.inflation_factor,
        }
      : null,
    baseline_components: v.baseline_components,
  };
}

type Metrics = {
  scenario_id: string;
  variant: "baseline" | "candidate";
  ok: boolean;
  issues?: string[];
  hitter_share: number | null;
  pitcher_share: number | null;
  top_player: { player_id: string; name?: string; auction_value: number } | null;
  top_hitter: { player_id: string; name?: string; auction_value: number } | null;
  top_pitcher: { player_id: string; name?: string; auction_value: number } | null;
  top25_mix: Record<string, number>;
  ge50: number;
  ge40: number;
  ge30: number;
  ge20: number;
  near_one: number;
  budget_ratio: number | null;
  replacement_OF: number | null;
  replacement_SP: number | null;
  replacement_RP: number | null;
  total_surplus_mass: number | null;
  inflation_factor: number | null;
  valuation_context_warnings: string[] | null;
  scoring_category_warnings: string[] | null;
  top_catcher_auction: number;
  top5_of_auction_sum: number;
  rp_closer_auction_sum_proxy: number;
  rec_minus_auction_mean_abs: number | null;
  team_adj_minus_auction_mean_abs: number | null;
};

function collectMetrics(
  scenario_id: string,
  variant: "baseline" | "candidate",
  pool: LeanPlayer[],
  input: NormalizedValuationInput,
  wf: ReturnType<typeof executeValuationWorkflow>
): Metrics {
  if (!wf.ok) {
    return {
      scenario_id,
      variant,
      ok: false,
      issues: wf.issues,
      hitter_share: null,
      pitcher_share: null,
      top_player: null,
      top_hitter: null,
      top_pitcher: null,
      top25_mix: {},
      ge50: 0,
      ge40: 0,
      ge30: 0,
      ge20: 0,
      near_one: 0,
      budget_ratio: null,
      replacement_OF: null,
      replacement_SP: null,
      replacement_RP: null,
      total_surplus_mass: null,
      inflation_factor: null,
      valuation_context_warnings: null,
      scoring_category_warnings: null,
      top_catcher_auction: 0,
      top5_of_auction_sum: 0,
      rp_closer_auction_sum_proxy: 0,
      rec_minus_auction_mean_abs: null,
      team_adj_minus_auction_mean_abs: null,
    };
  }
  const res = wf.response;
  const rows = res.valuations;
  const ov = positionOverridesFromRequest(input.position_overrides);
  const byId = new Map(pool.map((p) => [getPlayerId(p), p]));

  let hp = 0,
    pp = 0;
  for (const r of rows) {
    const lp = byId.get(r.player_id);
    if (!lp) continue;
    if (isPitcherForBaseline(lp, ov)) pp += num(r.auction_value);
    else hp += num(r.auction_value);
  }

  const sorted = [...rows].sort((a, b) => num(b.auction_value) - num(a.auction_value));
  const hitters = sorted.filter((r) => {
    const lp = byId.get(r.player_id);
    return lp && !isPitcherForBaseline(lp, ov);
  });
  const pitchers = sorted.filter((r) => {
    const lp = byId.get(r.player_id);
    return lp && isPitcherForBaseline(lp, ov);
  });

  let ge50 = 0,
    ge40 = 0,
    ge30 = 0,
    ge20 = 0,
    near1 = 0;
  for (const r of rows) {
    const av = num(r.auction_value);
    if (av >= 50) ge50++;
    if (av >= 40) ge40++;
    if (av >= 30) ge30++;
    if (av >= 20) ge20++;
    if (av > 0 && av <= 1.25) near1++;
  }

  const leagueBudget = input.total_budget * input.num_teams;
  const sumAll = rows.reduce((s, r) => s + num(r.auction_value), 0);

  const gaps: number[] = [];
  const tadj: number[] = [];
  for (const r of rows) {
    if (r.recommended_bid != null)
      gaps.push(Math.abs(num(r.recommended_bid) - num(r.auction_value)));
    if (r.team_adjusted_value != null)
      tadj.push(Math.abs(num(r.team_adjusted_value) - num(r.auction_value)));
  }

  const rv = res.replacement_values_by_slot_or_position ?? {};

  return {
    scenario_id,
    variant,
    ok: true,
    hitter_share: hp + pp > 0 ? hp / (hp + pp) : null,
    pitcher_share: hp + pp > 0 ? pp / (hp + pp) : null,
    top_player: sorted[0]
      ? {
          player_id: sorted[0].player_id,
          name: sorted[0].name,
          auction_value: num(sorted[0].auction_value),
        }
      : null,
    top_hitter: hitters[0]
      ? {
          player_id: hitters[0].player_id,
          name: hitters[0].name,
          auction_value: num(hitters[0].auction_value),
        }
      : null,
    top_pitcher: pitchers[0]
      ? {
          player_id: pitchers[0].player_id,
          name: pitchers[0].name,
          auction_value: num(pitchers[0].auction_value),
        }
      : null,
    top25_mix: positionalMix(sorted.slice(0, 25)),
    ge50,
    ge40,
    ge30,
    ge20,
    near_one: near1,
    budget_ratio: leagueBudget > 0 ? sumAll / leagueBudget : null,
    replacement_OF: rv.OF ?? null,
    replacement_SP: rv.SP ?? null,
    replacement_RP: rv.RP ?? null,
    total_surplus_mass: res.total_surplus_mass ?? null,
    inflation_factor: res.inflation_factor ?? null,
    valuation_context_warnings: res.valuation_context_warnings ?? null,
    scoring_category_warnings: res.scoring_category_warnings ?? null,
    top_catcher_auction: topCatcherAuction(rows),
    top5_of_auction_sum: topKOfSum(rows, 5),
    rp_closer_auction_sum_proxy: rpCloserSum(rows, pool, ov),
    rec_minus_auction_mean_abs: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    team_adj_minus_auction_mean_abs: tadj.length ? tadj.reduce((a, b) => a + b, 0) / tadj.length : null,
  };
}

function buildKeeperDraft(pool: LeanPlayer[], numTeams: number): DraftedPlayer[] {
  const sorted = [...pool].sort((a, b) => (a.adp ?? 9999) - (b.adp ?? 9999));
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

function excludedEliteIds(pool: LeanPlayer[], topN: number): string[] {
  const sorted = [...pool].sort(
    (a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)
  );
  return sorted.slice(0, topN).map((p) => getPlayerId(p));
}

type ScenarioDef = { id: string; description: string; build: () => NormalizedValuationInput };

function defineScenarios(pool: LeanPlayer[]): ScenarioDef[] {
  const obpCats = CALIBRATION_CATS_5X5.map((c) =>
    c.name === "AVG" ? { name: "OBP", type: "batting" as const } : c
  );
  const svHldCats = [
    ...CALIBRATION_CATS_5X5.filter((c) => c.name !== "SV"),
    { name: "SV", type: "pitching" as const },
    { name: "HLD", type: "pitching" as const },
  ];

  const noCiMi = draftroomUiDefaultRoster().filter(
    (s) => s.position !== "CI" && s.position !== "MI"
  );

  const thinIds = thinEligibleIds(pool, 120, 42);
  const exclIds = excludedEliteIds(pool, 18);

  const base = (): NormalizedValuationInput =>
    buildDraftroomStandardValuationInput({
      explain_valuation_rows: true,
      deterministic: true,
      seed: 42,
      inflation_model: "replacement_slots_v2",
    });

  return [
    { id: "standard_mixed_12", description: "Draftroom default 12-team mixed", build: base },
    {
      id: "shallow_10_team",
      description: "10-team (same per-team budget)",
      build: () => ({ ...base(), num_teams: 10 }),
    },
    {
      id: "deep_15_team",
      description: "15-team deep",
      build: () => ({ ...base(), num_teams: 15 }),
    },
    {
      id: "two_catcher",
      description: "2× C slots",
      build: () => ({
        ...base(),
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "C" ? { ...s, count: 2 } : s
        ),
      }),
    },
    {
      id: "five_outfielder",
      description: "5× OF",
      build: () => ({
        ...base(),
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "OF" ? { ...s, count: 5 } : s
        ),
      }),
    },
    {
      id: "no_ci_mi",
      description: "CI/MI slots removed",
      build: () => ({ ...base(), roster_slots: noCiMi }),
    },
    {
      id: "generic_P_slots",
      description: "Legacy generic P + extra RP",
      build: () => ({ ...base(), roster_slots: legacyEngineCalibrationRoster() }),
    },
    {
      id: "sp_rp_split_default",
      description: "Explicit label for SP/RP split roster (same as default)",
      build: base,
    },
    {
      id: "OBP_instead_of_AVG",
      description: "OBP category swap",
      build: () => ({ ...base(), scoring_categories: obpCats }),
    },
    {
      id: "saves_only_scoring",
      description: "Saves-only style pitching cats",
      build: () => ({
        ...base(),
        scoring_categories: CALIBRATION_CATS_SAVES_ONLY,
      }),
    },
    {
      id: "SV_HLD_warning_case",
      description: "SV+HLD — combined saves + holds category",
      build: () => ({
        ...base(),
        scoring_categories: svHldCats,
        strict_scoring_categories: false,
      }),
    },
    {
      id: "AL_only",
      description: "AL league scope",
      build: () => ({ ...base(), league_scope: "AL" }),
    },
    {
      id: "NL_only",
      description: "NL league scope",
      build: () => ({ ...base(), league_scope: "NL" }),
    },
    {
      id: "keeper_spread_realistic",
      description: "36 keepers across teams with spread costs",
      build: () => ({
        ...base(),
        drafted_players: buildKeeperDraft(pool, 12),
      }),
    },
    {
      id: "thin_eligible_subset",
      description: "120-player eligible subset",
      build: () => ({ ...base(), eligible_player_ids: thinIds }),
    },
    {
      id: "excluded_elite_players",
      description: "Top 18 catalog values excluded",
      build: () => ({ ...base(), excluded_player_ids: exclIds }),
    },
    {
      id: "draft_checkpoint_0",
      description: "Pre-draft (same as empty drafted)",
      build: base,
    },
    {
      id: "draft_checkpoint_25",
      description: "25 picks off the board (ADP snake)",
      build: () => ({
        ...base(),
        drafted_players: draftByAdpOrder(pool, 25, 12, base().total_budget),
      }),
    },
    {
      id: "draft_checkpoint_75",
      description: "75 picks",
      build: () => ({
        ...base(),
        drafted_players: draftByAdpOrder(pool, 75, 12, base().total_budget),
      }),
    },
    {
      id: "draft_checkpoint_150",
      description: "150 picks",
      build: () => ({
        ...base(),
        drafted_players: draftByAdpOrder(pool, 150, 12, base().total_budget),
      }),
    },
    {
      id: "asymmetric_budget_team1",
      description: "team_1 tight budget + skew",
      build: () => ({
        ...base(),
        user_team_id: "team_1",
        budget_by_team_id: Object.fromEntries(
          Array.from({ length: 12 }, (_, i) => [
            `team_${i + 1}`,
            i === 0 ? 55 : 260,
          ])
        ),
      }),
    },
  ];
}

function regressionFlags(
  scenarioId: string,
  b: Metrics,
  c: Metrics
): string[] {
  const flags: string[] = [];
  if (!b.ok || !c.ok) return flags;
  const ps = c.pitcher_share ?? 0;
  const hs = c.hitter_share ?? 0;
  if (ps > 0.4) flags.push("pitcher_share_above_40pct");
  if (hs < 0.55) flags.push("hitter_share_below_55pct");
  if (
    scenarioId === "standard_mixed_12" &&
    (c.top_pitcher?.auction_value ?? 0) > (c.top_hitter?.auction_value ?? 0)
  ) {
    flags.push("top_pitcher_exceeds_top_hitter");
  }
  const brb = b.budget_ratio ?? 0;
  const brc = c.budget_ratio ?? 0;
  if (brb > 0 && Math.abs(brc - brb) / brb > 0.05) flags.push("budget_ratio_shift_gt_5pct_vs_baseline_scenario");
  return flags;
}

/** Minimal Monte oddity proxy: snapshot oddities at pick 0 only */
function detectPick0Oddities(m: Metrics): string[] {
  const o: string[] = [];
  if ((m.pitcher_share ?? 0) > 0.42 && m.scenario_id.includes("draft_checkpoint")) return o;
  if ((m.pitcher_share ?? 0) > 0.42 && m.scenario_id === "standard_mixed_12") {
    o.push("pitcher_heavy_board_start");
  }
  return o;
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
  };

  const scenarios = defineScenarios(pool);
  const baselineRows: Metrics[] = [];
  const candidateRows: Metrics[] = [];

  for (const sc of scenarios) {
    const input = sc.build();
    restoreShipped(snap);
    const wfB = executeValuationWorkflow(pool, input, {});
    baselineRows.push(collectMetrics(sc.id, "baseline", pool, input, wfB));

    applyCandidate(snap);
    const wfC = executeValuationWorkflow(pool, input, {});
    candidateRows.push(collectMetrics(sc.id, "candidate", pool, input, wfC));
    restoreShipped(snap);
  }

  const regressions: {
    scenario_id: string;
    flags: string[];
    baseline: Metrics;
    candidate: Metrics;
  }[] = [];
  for (let i = 0; i < scenarios.length; i++) {
    const id = scenarios[i]!.id;
    const b = baselineRows[i]!;
    const c = candidateRows[i]!;
    regressions.push({
      scenario_id: id,
      flags: regressionFlags(id, b, c),
      baseline: b,
      candidate: c,
    });
  }

  const stdIdx = scenarios.findIndex((s) => s.id === "standard_mixed_12");
  const stdB = baselineRows[stdIdx]!;
  const stdC = candidateRows[stdIdx]!;
  const stdInput = scenarios[stdIdx]!.build();

  restoreShipped(snap);
  const wfStdB = executeValuationWorkflow(pool, stdInput, {});
  applyCandidate(snap);
  const wfStdC = executeValuationWorkflow(pool, stdInput, {});
  restoreShipped(snap);

  let top10Before: unknown[] = [];
  let top10After: unknown[] = [];
  let traceBefore: Record<string, unknown> | null = null;
  let traceAfter: Record<string, unknown> | null = null;

  if (wfStdB.ok && wfStdC.ok) {
    const sortedB = [...wfStdB.response.valuations].sort(
      (a, b) => num(b.auction_value) - num(a.auction_value)
    );
    const sortedC = [...wfStdC.response.valuations].sort(
      (a, b) => num(b.auction_value) - num(a.auction_value)
    );
    top10Before = sortedB.slice(0, 10).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      auction_value: r.auction_value,
    }));
    top10After = sortedC.slice(0, 10).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      auction_value: r.auction_value,
    }));

    const ov = positionOverridesFromRequest(stdInput.position_overrides);
    const byId = new Map(pool.map((p) => [getPlayerId(p), p]));
    const hitB = sortedB.filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && !isPitcherForBaseline(lp, ov);
    });
    const pitB = sortedB.filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && isPitcherForBaseline(lp, ov);
    });
    const pitchersB = sortedB.filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && isPitcherForBaseline(lp, ov);
    });
    const midIdx = Math.min(14, Math.max(0, pitchersB.length - 1));

    const topOf =
      hitB.find((r) => {
        const pos = (r.position ?? "").toUpperCase();
        return pos.includes("OF") || pos.includes("LF") || pos.includes("CF") || pos.includes("RF");
      }) ?? hitB[0];
    const topP = pitB[0];
    const midP = pitchersB[midIdx];

    const rowCb = wfStdC.response.valuations.find((v) => v.player_id === topOf?.player_id);
    const rowPb = wfStdB.response.valuations.find((v) => v.player_id === topP?.player_id);
    const rowPa = wfStdC.response.valuations.find((v) => v.player_id === topP?.player_id);
    const rowMb = wfStdB.response.valuations.find((v) => v.player_id === midP?.player_id);
    const rowMa = wfStdC.response.valuations.find((v) => v.player_id === midP?.player_id);

    traceBefore = {
      top_of_hitter: traceRow(wfStdB.response.valuations.find((v) => v.player_id === topOf?.player_id)),
      top_pitcher: traceRow(rowPb),
      mid_tier_pitcher: traceRow(rowMb),
    };
    traceAfter = {
      top_of_hitter: traceRow(rowCb),
      top_pitcher: traceRow(rowPa),
      mid_tier_pitcher: traceRow(rowMa),
    };
  }

  const oneC = baselineRows.find((x) => x.scenario_id === "standard_mixed_12")!;
  const twoC = baselineRows.find((x) => x.scenario_id === "two_catcher")!;
  const oneCc = candidateRows.find((x) => x.scenario_id === "standard_mixed_12")!;
  const twoCc = candidateRows.find((x) => x.scenario_id === "two_catcher")!;

  const threeOfb = baselineRows.find((x) => x.scenario_id === "standard_mixed_12")!;
  const fiveOfb = baselineRows.find((x) => x.scenario_id === "five_outfielder")!;
  const threeOfc = candidateRows.find((x) => x.scenario_id === "standard_mixed_12")!;
  const fiveOfc = candidateRows.find((x) => x.scenario_id === "five_outfielder")!;

  const pairedInspection = {
    catcher_top_auction_1c_vs_2c: {
      baseline: { one_c: oneC.top_catcher_auction, two_c: twoC.top_catcher_auction },
      candidate: { one_c: oneCc.top_catcher_auction, two_c: twoCc.top_catcher_auction },
      two_c_raises_vs_1c_baseline: twoC.top_catcher_auction >= oneC.top_catcher_auction - 0.01,
      two_c_raises_vs_1c_candidate: twoCc.top_catcher_auction >= oneCc.top_catcher_auction - 0.01,
    },
    of_top5_sum_3of_vs_5of: {
      baseline: { three_of_setting: threeOfb.top5_of_auction_sum, five_of: fiveOfb.top5_of_auction_sum },
      candidate: { three_of_setting: threeOfc.top5_of_auction_sum, five_of: fiveOfc.top5_of_auction_sum },
      five_of_raises_baseline: fiveOfb.top5_of_auction_sum > threeOfb.top5_of_auction_sum - 0.01,
      five_of_raises_candidate: fiveOfc.top5_of_auction_sum > threeOfc.top5_of_auction_sum - 0.01,
    },
    saves_only_rp_proxy_sums: {
      baseline: baselineRows.find((x) => x.scenario_id === "saves_only_scoring")?.rp_closer_auction_sum_proxy,
      candidate: candidateRows.find((x) => x.scenario_id === "saves_only_scoring")?.rp_closer_auction_sum_proxy,
    },
    al_nl_top_player: {
      AL: {
        baseline: baselineRows.find((x) => x.scenario_id === "AL_only")?.top_player,
        candidate: candidateRows.find((x) => x.scenario_id === "AL_only")?.top_player,
      },
      NL: {
        baseline: baselineRows.find((x) => x.scenario_id === "NL_only")?.top_player,
        candidate: candidateRows.find((x) => x.scenario_id === "NL_only")?.top_player,
      },
    },
    recommended_bid_gap_delta_standard_mixed: {
      baseline_mean_abs: stdB.rec_minus_auction_mean_abs,
      candidate_mean_abs: stdC.rec_minus_auction_mean_abs,
      delta:
        stdB.rec_minus_auction_mean_abs != null && stdC.rec_minus_auction_mean_abs != null
          ? stdC.rec_minus_auction_mean_abs - stdB.rec_minus_auction_mean_abs
          : null,
    },
    team_adj_gap_delta_asymmetric: {
      scenario: "asymmetric_budget_team1",
      baseline_mean_abs: baselineRows.find((x) => x.scenario_id === "asymmetric_budget_team1")
        ?.team_adj_minus_auction_mean_abs,
      candidate_mean_abs: candidateRows.find((x) => x.scenario_id === "asymmetric_budget_team1")
        ?.team_adj_minus_auction_mean_abs,
    },
  };

  const miniMonteBaseline = runMiniMonteOddityEstimate(pool, snap, false);
  const miniMonteCandidate = runMiniMonteOddityEstimate(pool, snap, true);
  const oddityRatio =
    miniMonteBaseline.count > 0 ? miniMonteCandidate.count / miniMonteBaseline.count : null;

  restoreShipped(snap);

  const recommendation = (() => {
    const std = regressions.find((r) => r.scenario_id === "standard_mixed_12");
    const catcherOk =
      pairedInspection.catcher_top_auction_1c_vs_2c.two_c_raises_vs_1c_candidate !== false;
    const ofOk = pairedInspection.of_top5_sum_3of_vs_5of.five_of_raises_candidate !== false;
    if ((std && std.flags.length > 0) || !catcherOk || !ofOk) return "reject_or_adjust";
    if (oddityRatio != null && oddityRatio > 1.1) return "adjust_candidate";
    const budgetDrift = regressions.some(
      (r) =>
        r.flags.includes("budget_ratio_shift_gt_5pct_vs_baseline_scenario") &&
        !r.scenario_id.startsWith("draft_checkpoint_")
    );
    if (budgetDrift) return "adjust_candidate";
    const edgePitcherHeavy = regressions.filter(
      (r) =>
        r.flags.includes("pitcher_share_above_40pct") &&
        r.scenario_id !== "generic_P_slots" &&
        r.scenario_id !== "thin_eligible_subset" &&
        r.scenario_id !== "draft_checkpoint_75" &&
        r.scenario_id !== "draft_checkpoint_150" &&
        r.scenario_id !== "AL_only"
    );
    if (edgePitcherHeavy.length > 0) return "adjust_candidate";
    return "ship_candidate_with_monitoring";
  })();

  const payload = {
    generatedAt: new Date().toISOString(),
    catalog_rows: pool.length,
    candidate_definition: {
      ROTO_INTRINSIC_BASE_PITCHER: "+3 vs shipped",
      ROTO_Z_PITCHER_zHi: "+0.10 vs shipped",
    },
    side_by_side_table: regressions.map((r) => ({
      scenario_id: r.scenario_id,
      hitter_share: { baseline: r.baseline.hitter_share, candidate: r.candidate.hitter_share },
      pitcher_share: { baseline: r.baseline.pitcher_share, candidate: r.candidate.pitcher_share },
      top_player: { baseline: r.baseline.top_player, candidate: r.candidate.top_player },
      top_hitter: { baseline: r.baseline.top_hitter, candidate: r.candidate.top_hitter },
      top_pitcher: { baseline: r.baseline.top_pitcher, candidate: r.candidate.top_pitcher },
      ge50: { baseline: r.baseline.ge50, candidate: r.candidate.ge50 },
      ge40: { baseline: r.baseline.ge40, candidate: r.candidate.ge40 },
      ge30: { baseline: r.baseline.ge30, candidate: r.candidate.ge30 },
      ge20: { baseline: r.baseline.ge20, candidate: r.candidate.ge20 },
      near_one: { baseline: r.baseline.near_one, candidate: r.candidate.near_one },
      budget_ratio: { baseline: r.baseline.budget_ratio, candidate: r.candidate.budget_ratio },
      replacement: {
        OF: { baseline: r.baseline.replacement_OF, candidate: r.candidate.replacement_OF },
        SP: { baseline: r.baseline.replacement_SP, candidate: r.candidate.replacement_SP },
        RP: { baseline: r.baseline.replacement_RP, candidate: r.candidate.replacement_RP },
      },
      total_surplus_mass: {
        baseline: r.baseline.total_surplus_mass,
        candidate: r.candidate.total_surplus_mass,
      },
      inflation_factor: {
        baseline: r.baseline.inflation_factor,
        candidate: r.candidate.inflation_factor,
      },
      warnings: {
        valuation_context: {
          baseline: r.baseline.valuation_context_warnings,
          candidate: r.candidate.valuation_context_warnings,
        },
        scoring_category: {
          baseline: r.baseline.scoring_category_warnings,
          candidate: r.candidate.scoring_category_warnings,
        },
      },
      rec_gap_mean_abs: {
        baseline: r.baseline.rec_minus_auction_mean_abs,
        candidate: r.candidate.rec_minus_auction_mean_abs,
      },
      team_adj_gap_mean_abs: {
        baseline: r.baseline.team_adj_minus_auction_mean_abs,
        candidate: r.candidate.team_adj_minus_auction_mean_abs,
      },
    })),
    regression_table: regressions.map((r) => ({
      scenario_id: r.scenario_id,
      flags: r.flags,
    })),
    mini_monte_oddity_proxy: {
      note: "Lightweight pick-0 sanity oddities + pitcher-heavy start; not full monte-carlo-draft-valuation-audit.ts",
      baseline_count: miniMonteBaseline.count,
      candidate_count: miniMonteCandidate.count,
      ratio_candidate_to_baseline: oddityRatio,
      regression_gt_10pct_increase: oddityRatio != null && oddityRatio > 1.1,
    },
    standard_mixed_top10: { before: top10Before, after: top10After },
    formula_traces_standard_mixed: { before_shipped: traceBefore, after_candidate: traceAfter },
    paired_inspection: pairedInspection,
    recommendation,
    regression_summary: {
      scenarios_with_any_flag: regressions.filter((r) => r.flags.length > 0).length,
      flag_counts_by_type: ["pitcher_share_above_40pct", "hitter_share_below_55pct", "budget_ratio_shift_gt_5pct_vs_baseline_scenario", "top_pitcher_exceeds_top_hitter"].reduce(
        (acc, k) => {
          acc[k] = regressions.filter((r) => r.flags.includes(k)).length;
          return acc;
        },
        {} as Record<string, number>
      ),
      note:
        "Mid-draft checkpoints often diverge in Σauction/leagueBudget vs pre-draft; paired with thin pools this is expected — review draft_checkpoint rows manually.",
    },
    recommendation_notes: {
      ship_candidate_with_monitoring:
        "Candidate improves mixed split without systematic regressions in paired roster checks; monitor catalog refreshes.",
      adjust_candidate:
        "Non-draft budget drift, oddity proxy >10%, or unexpected pitcher-heavy scenarios outside known edge cases.",
      reject_or_adjust:
        "standard_mixed_12 regression flags or 2C/5OF pairing checks failed — do not ship as-is.",
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ wrote: OUT, recommendation }, null, 2));

  function runMiniMonteOddityEstimate(poolIn: LeanPlayer[], s: Snap, candidate: boolean): { count: number } {
    let count = 0;
    for (let d = 0; d < 12; d++) {
      const input = buildDraftroomStandardValuationInput({
        user_team_id: "team_1",
        deterministic: true,
        seed: 42 + d,
      });
      if (candidate) applyCandidate(s);
      else restoreShipped(s);
      const wf = executeValuationWorkflow(poolIn, input, {});
      if (!wf.ok) continue;
      const m = collectMetrics("mini_monte", candidate ? "candidate" : "baseline", poolIn, input, wf);
      count += detectPick0Oddities(m).length;
      if ((m.pitcher_share ?? 0) > 0.42) count += 1;
    }
    restoreShipped(s);
    return { count };
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
