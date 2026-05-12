import type { PlayerSyncDoc } from "./mlbPlayerSyncFromSplits";
import { isValuationEligibleCatalogRow } from "./catalogRowClassification";
import { getPlayerId } from "./playerId";
import { positionOverridesFromRequest } from "./fantasyRosterSlots";
import { isPitcherForBaseline } from "../services/baselineProjectionStats";
import type { LeanPlayer, NormalizedValuationInput } from "../types/brain";
import type { ValuationWorkflowResult } from "../services/valuationWorkflow";
import type { ValuedPlayer, ValuationResponse } from "../types/valuation";

export function playerSyncDocsToValuationLeanPlayers(docs: PlayerSyncDoc[]): LeanPlayer[] {
  const out: LeanPlayer[] = [];
  for (const d of docs) {
    if (d.catalogValuationTier === "market_only" || d.catalogValuationTier === "roster_context") {
      continue;
    }
    out.push({
      _id: `ru_v1_${d.mlbId}`,
      mlbId: d.mlbId,
      catalogKind: d.catalogKind,
      catalogValuationTier: d.catalogValuationTier,
      name: d.name,
      team: d.team,
      position: d.position,
      positions: d.positions,
      age: d.age,
      depthChartPosition: d.depthChartPosition,
      catalog_rank: d.catalog_rank ?? 9999,
      catalog_tier: d.catalog_tier,
      value: d.value,
      outlook: d.outlook,
      stats: d.stats as Record<string, unknown> | undefined,
      projection: d.projection as Record<string, unknown> | undefined,
      market_adp: d.market_adp,
      market_adp_source: d.market_adp_source,
      market_adp_updated_at: d.market_adp_updated_at,
      market_adp_min: d.market_adp_min,
      market_adp_max: d.market_adp_max,
      market_pick_count: d.market_pick_count,
    });
  }
  return out;
}

export function filterMongoValuationEligiblePool(players: LeanPlayer[]): LeanPlayer[] {
  return players.filter((p) => isValuationEligibleCatalogRow(p));
}

function rowBucket(
  row: ValuedPlayer,
  byId: Map<string, LeanPlayer>,
  ov: ReturnType<typeof positionOverridesFromRequest>
): "hitter" | "pitcher" {
  const sel = row.baseline_components?.two_way_role_selected;
  if (sel === "hitter" || sel === "pitcher") return sel;
  const lp = byId.get(row.player_id);
  if (!lp) return "hitter";
  return isPitcherForBaseline(lp, ov) ? "pitcher" : "hitter";
}

function sortedByAv(rows: ValuedPlayer[]): ValuedPlayer[] {
  return [...rows].sort((a, b) => b.auction_value - a.auction_value);
}

export type ValuationCalibrationSnapshot = {
  scenario_id: string;
  ok: boolean;
  issues?: string[];
  eligible_pool_size: number;
  draftable_pool_size: number;
  hitter_valuation_rows: number;
  pitcher_valuation_rows: number;
  top25_auction_value: { player_id: string; name: string; position: string; auction_value: number }[];
  top25_hitters: { player_id: string; name: string; position: string; auction_value: number }[];
  top25_pitchers: { player_id: string; name: string; position: string; auction_value: number }[];
  top10_sp: { player_id: string; name: string; auction_value: number }[];
  top10_rp: { player_id: string; name: string; auction_value: number }[];
  top_catchers: { player_id: string; name: string; auction_value: number }[];
  ge_50: number;
  ge_40: number;
  ge_30: number;
  ge_20: number;
  near_one_dollar_count: number;
  draftable_sum_auction_value: number;
  league_budget: number;
  draftable_sum_to_league_budget_ratio: number;
  hitter_auction_mass: number;
  pitcher_auction_mass: number;
  hitter_auction_share: number;
  replacement_values_by_slot_or_position: Record<string, number> | null;
};

export function summarizeValuationResponse(
  scenarioId: string,
  pool: LeanPlayer[],
  input: NormalizedValuationInput,
  wf: ValuationWorkflowResult
): ValuationCalibrationSnapshot {
  if (!wf.ok) {
    return {
      scenario_id: scenarioId,
      ok: false,
      issues: wf.issues,
      eligible_pool_size: 0,
      draftable_pool_size: 0,
      hitter_valuation_rows: 0,
      pitcher_valuation_rows: 0,
      top25_auction_value: [],
      top25_hitters: [],
      top25_pitchers: [],
      top10_sp: [],
      top10_rp: [],
      top_catchers: [],
      ge_50: 0,
      ge_40: 0,
      ge_30: 0,
      ge_20: 0,
      near_one_dollar_count: 0,
      draftable_sum_auction_value: 0,
      league_budget: input.total_budget * input.num_teams,
      draftable_sum_to_league_budget_ratio: 0,
      hitter_auction_mass: 0,
      pitcher_auction_mass: 0,
      hitter_auction_share: 0,
      replacement_values_by_slot_or_position: null,
    };
  }
  const res = wf.response;
  const rows = res.valuations;
  const ov = positionOverridesFromRequest(input.position_overrides);
  const byId = new Map(pool.map((p) => [getPlayerId(p), p]));

  let hitRows = 0;
  let pitRows = 0;
  let hit$ = 0;
  let pit$ = 0;
  for (const r of rows) {
    const b = rowBucket(r, byId, ov);
    if (b === "pitcher") {
      pitRows++;
      pit$ += r.auction_value;
    } else {
      hitRows++;
      hit$ += r.auction_value;
    }
  }
  const hp = hit$ + pit$;

  const sorted = sortedByAv(rows);
  const top25 = sorted.slice(0, 25).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    auction_value: r.auction_value,
  }));

  const hitSorted = sorted.filter((r) => rowBucket(r, byId, ov) === "hitter");
  const pitSorted = sorted.filter((r) => rowBucket(r, byId, ov) === "pitcher");

  const top25Hit = hitSorted.slice(0, 25).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    auction_value: r.auction_value,
  }));
  const top25Pit = pitSorted.slice(0, 25).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    auction_value: r.auction_value,
  }));

  const spRows = sorted.filter((r) => (r.position ?? "").toUpperCase().includes("SP"));
  const rpRows = sorted.filter((r) => {
    const p = (r.position ?? "").toUpperCase();
    return p.includes("RP") || p === "P";
  });
  const top10Sp = spRows.slice(0, 10).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    auction_value: r.auction_value,
  }));
  const top10Rp = rpRows.slice(0, 10).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    auction_value: r.auction_value,
  }));

  const catchers = sorted.filter((r) => (r.position ?? "").toUpperCase().trim() === "C");
  const topCatchers = catchers.slice(0, 10).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    auction_value: r.auction_value,
  }));

  const ge = (t: number) => rows.filter((r) => r.auction_value >= t).length;
  const nearOne = rows.filter((r) => r.auction_value <= 1.05 && r.auction_value >= 0).length;

  const dps = res.draftable_pool_size ?? 0;
  const draftableSum =
    dps > 0 ? sorted.slice(0, dps).reduce((s, r) => s + r.auction_value, 0) : 0;
  const leagueBudget = input.total_budget * input.num_teams;

  const eligible = res.valuation_context?.eligible_pool_size ?? rows.length;

  return {
    scenario_id: scenarioId,
    ok: true,
    eligible_pool_size: eligible,
    draftable_pool_size: dps,
    hitter_valuation_rows: hitRows,
    pitcher_valuation_rows: pitRows,
    top25_auction_value: top25,
    top25_hitters: top25Hit,
    top25_pitchers: top25Pit,
    top10_sp: top10Sp,
    top10_rp: top10Rp,
    top_catchers: topCatchers,
    ge_50: ge(50),
    ge_40: ge(40),
    ge_30: ge(30),
    ge_20: ge(20),
    near_one_dollar_count: nearOne,
    draftable_sum_auction_value: draftableSum,
    league_budget: leagueBudget,
    draftable_sum_to_league_budget_ratio: leagueBudget > 0 ? draftableSum / leagueBudget : 0,
    hitter_auction_mass: hit$,
    pitcher_auction_mass: pit$,
    hitter_auction_share: hp > 0 ? hit$ / hp : 0,
    replacement_values_by_slot_or_position: res.replacement_values_by_slot_or_position ?? null,
  };
}

export function spotlightAuctionCompare(
  spotlightMlbIds: number[],
  mongoRes: ValuationResponse,
  rosterRes: ValuationResponse
): {
  mlbId: number;
  mongo_auction_value: number | null;
  roster_auction_value: number | null;
  delta: number | null;
  pct_change_vs_mongo: number | null;
}[] {
  const mBy = new Map(mongoRes.valuations.map((v) => [v.player_id, v]));
  const rBy = new Map(rosterRes.valuations.map((v) => [v.player_id, v]));
  return spotlightMlbIds.map((mlbId) => {
    const id = String(mlbId);
    const m = mBy.get(id)?.auction_value;
    const r = rBy.get(id)?.auction_value;
    const dm = m != null && Number.isFinite(m) ? m : null;
    const dr = r != null && Number.isFinite(r) ? r : null;
    let delta: number | null = null;
    let pct: number | null = null;
    if (dm != null && dr != null) {
      delta = dr - dm;
      pct = dm !== 0 ? (dr - dm) / dm : null;
    }
    return {
      mlbId,
      mongo_auction_value: dm,
      roster_auction_value: dr,
      delta,
      pct_change_vs_mongo: pct,
    };
  });
}

export function starStabilitySample(
  mongoRes: ValuationResponse,
  rosterRes: ValuationResponse,
  topN: number
): {
  player_id: string;
  name: string;
  mongo_auction_value: number;
  roster_auction_value: number | null;
  pct_change_vs_mongo: number | null;
}[] {
  const mongoSorted = sortedByAv(mongoRes.valuations).slice(0, topN);
  const rBy = new Map(rosterRes.valuations.map((v) => [v.player_id, v]));
  return mongoSorted.map((row) => {
    const r = rBy.get(row.player_id)?.auction_value;
    const m = row.auction_value;
    const rr = r != null && Number.isFinite(r) ? r : null;
    return {
      player_id: row.player_id,
      name: row.name,
      mongo_auction_value: m,
      roster_auction_value: rr,
      pct_change_vs_mongo: rr != null && m !== 0 ? (rr - m) / m : null,
    };
  });
}

/** 24-char hex — Mongo ObjectId shape; roster-universe catalog should use MLB numeric ids. */
const OBJECTID_HEX_RE = /^[a-f0-9]{24}$/i;

export function playerIdLooksLikeMongoObjectId(playerId: string): boolean {
  return OBJECTID_HEX_RE.test(playerId);
}

export function rosterUniverseWritePlayerIdAudit(pool: LeanPlayer[]): {
  roster_valuation_player_ids_objectid_free: boolean;
  invalid_player_id_examples: string[];
} {
  const bad: string[] = [];
  for (const p of pool) {
    const id = getPlayerId(p);
    if (playerIdLooksLikeMongoObjectId(id)) bad.push(id);
    if (bad.length >= 20) break;
  }
  return {
    roster_valuation_player_ids_objectid_free: bad.length === 0,
    invalid_player_id_examples: bad,
  };
}

export type CollapseClassification =
  | "expected_wider_pool"
  | "suspicious_projection_artifact"
  | "position_replacement_artifact";

export type CollapsedPlayerCalibrationRow = {
  player_id: string;
  name: string;
  position: string;
  effective_positions_old: string[] | null;
  effective_positions_new: string[] | null;
  old_auction_value: number;
  new_auction_value: number;
  old_replacement_key: string | null;
  new_replacement_key: string | null;
  old_replacement_value: number | null;
  new_replacement_value: number | null;
  old_surplus_basis: number | null;
  new_surplus_basis: number | null;
  old_baseline_value: number;
  new_baseline_value: number;
  mongo_auction_threshold_bucket: ">=20" | ">=10_lt20";
  collapse_classification: CollapseClassification;
  collapse_rationale: string;
};

function explainSnapshot(v: ValuedPlayer): {
  effective_positions: string[] | null;
  replacement_key: string | null;
  replacement_value: number | null;
  surplus_basis: number | null;
} {
  const ex = v.valuation_explain;
  const dbg = v.debug_v2;
  return {
    effective_positions: ex?.effective_positions ?? null,
    replacement_key: ex?.replacement_key_used ?? dbg?.replacement_key_used ?? null,
    replacement_value: ex?.replacement_value_used ?? dbg?.replacement_value_used ?? null,
    surplus_basis: ex?.surplus_basis ?? dbg?.surplus_basis ?? null,
  };
}

export function classifyAuctionFloorCollapse(args: {
  oldReplacementKey: string | null;
  newReplacementKey: string | null;
  mongoBaseline: number;
  rosterBaseline: number;
}): { classification: CollapseClassification; rationale: string } {
  const norm = (k: string | null | undefined) => k ?? "";
  if (norm(args.oldReplacementKey) !== norm(args.newReplacementKey)) {
    return {
      classification: "position_replacement_artifact",
      rationale: `Replacement slot changed (${args.oldReplacementKey ?? "null"} -> ${args.newReplacementKey ?? "null"}), which can re-route surplus even when raw projections are similar.`,
    };
  }
  const mb = args.mongoBaseline;
  const rb = args.rosterBaseline;
  const denom = Math.max(Math.abs(mb), 1e-6);
  const baselineRatio = rb / denom;
  if (mb > 5 && baselineRatio < 0.15) {
    return {
      classification: "suspicious_projection_artifact",
      rationale: `Baseline cratered vs Mongo (${mb.toFixed(2)} -> ${rb.toFixed(2)}) without a replacement-key change — inspect projection wiring or stat gates for this player.`,
    };
  }
  if (mb > 3 && baselineRatio < 0.35) {
    return {
      classification: "expected_wider_pool",
      rationale: `Large baseline drop (${mb.toFixed(2)} -> ${rb.toFixed(2)}) with stable replacement key — typical z-score / depth re-rank when many similar players join the pool.`,
    };
  }
  if (baselineRatio >= 0.65) {
    return {
      classification: "expected_wider_pool",
      rationale: `Baseline stayed in-family (${mb.toFixed(2)} -> ${rb.toFixed(2)}) but auction dollars collapsed — dollars spread across a wider marginal tier under replacement_slots_v2.`,
    };
  }
  return {
    classification: "expected_wider_pool",
    rationale: `Moderate baseline move with wider pool context; review if min-bid dollars still feel wrong for this role.`,
  };
}

export function buildMongoToFloorCollapseRows(args: {
  mongoVals: ValuedPlayer[];
  rosterVals: ValuedPlayer[];
  floorMax: number;
}): CollapsedPlayerCalibrationRow[] {
  const rBy = new Map(args.rosterVals.map((v) => [v.player_id, v]));
  const rows: CollapsedPlayerCalibrationRow[] = [];
  for (const m of args.mongoVals) {
    if (m.auction_value < 10) continue;
    const r = rBy.get(m.player_id);
    if (!r) continue;
    if (r.auction_value > args.floorMax) continue;
    const eo = explainSnapshot(m);
    const en = explainSnapshot(r);
    const bucket: ">=20" | ">=10_lt20" = m.auction_value >= 20 ? ">=20" : ">=10_lt20";
    const { classification, rationale } = classifyAuctionFloorCollapse({
      oldReplacementKey: eo.replacement_key,
      newReplacementKey: en.replacement_key,
      mongoBaseline: m.baseline_value,
      rosterBaseline: r.baseline_value,
    });
    rows.push({
      player_id: m.player_id,
      name: m.name,
      position: m.position,
      effective_positions_old: eo.effective_positions,
      effective_positions_new: en.effective_positions,
      old_auction_value: m.auction_value,
      new_auction_value: r.auction_value,
      old_replacement_key: eo.replacement_key,
      new_replacement_key: en.replacement_key,
      old_replacement_value: eo.replacement_value,
      new_replacement_value: en.replacement_value,
      old_surplus_basis: eo.surplus_basis,
      new_surplus_basis: en.surplus_basis,
      old_baseline_value: m.baseline_value,
      new_baseline_value: r.baseline_value,
      mongo_auction_threshold_bucket: bucket,
      collapse_classification: classification,
      collapse_rationale: rationale,
    });
  }
  rows.sort((a, b) => b.old_auction_value - a.old_auction_value);
  return rows;
}

export function top25AuctionPlayerOverlapFromValuations(
  mongoVals: ValuedPlayer[],
  rosterVals: ValuedPlayer[]
): {
  overlap_count: number;
  mongo_only_player_ids: string[];
  roster_only_player_ids: string[];
} {
  const top = (vs: ValuedPlayer[]) =>
    [...vs].sort((a, b) => b.auction_value - a.auction_value).slice(0, 25).map((v) => v.player_id);
  const m = new Set(top(mongoVals));
  const r = new Set(top(rosterVals));
  let overlap = 0;
  for (const id of m) {
    if (r.has(id)) overlap++;
  }
  return {
    overlap_count: overlap,
    mongo_only_player_ids: [...m].filter((id) => !r.has(id)),
    roster_only_player_ids: [...r].filter((id) => !m.has(id)),
  };
}

export type RosterUniverseWriteGuardrails = {
  safe_to_enable_writes: boolean;
  requires_review: boolean;
  reasons: string[];
  soft_warnings: string[];
  collapse_20_to_floor_count: number;
  collapse_10_to_floor_count: number;
  collapsed_players: CollapsedPlayerCalibrationRow[];
  collapse_classification_counts: Record<CollapseClassification, number>;
  top25_auction_overlap_count: number;
  top25_mongo_only_player_ids: string[];
  top25_roster_only_player_ids: string[];
  roster_valuation_player_ids_objectid_free: boolean;
  invalid_player_id_examples: string[];
  star_mean_abs_pct_change_vs_roster: number | null;
  star_mean_abs_pct_below_threshold: boolean;
  thresholds: {
    draftable_budget_ratio_low: number;
    draftable_budget_ratio_high: number;
    star_mean_abs_pct_max: number;
    max_top25_star_drawdowns_lt_neg_38pct: number;
    collapse_20_to_floor_max_for_safe: number;
    auction_floor_le_dollars: number;
  };
};

export function assessRosterUniverseWriteGuardrails(args: {
  mongoStd: ValuationCalibrationSnapshot;
  rosterStd: ValuationCalibrationSnapshot;
  starSample: ReturnType<typeof starStabilitySample>;
  spotlight: ReturnType<typeof spotlightAuctionCompare>;
  rosterPool: LeanPlayer[];
  spotlightMlbIds: number[];
  mongoStandardVals: ValuedPlayer[];
  rosterStandardVals: ValuedPlayer[];
  mongoExplainVals: ValuedPlayer[] | null;
  rosterExplainVals: ValuedPlayer[] | null;
  mongoExplainOk: boolean;
  rosterExplainOk: boolean;
}): RosterUniverseWriteGuardrails {
  const reasons: string[] = [];
  const softWarnings: string[] = [];
  const ratioLow = 0.955;
  const ratioHigh = 1.045;
  const starMeanMax = 0.45;
  const maxBigDrawdowns = 3;
  const floorDollars = 1.05;

  const ratioBand = (x: number) => x >= ratioLow && x <= ratioHigh;

  if (!args.mongoStd.ok) reasons.push("mongo_standard_scenario_failed");
  if (!args.rosterStd.ok) reasons.push("roster_standard_scenario_failed");
  if (args.mongoStd.ok && !ratioBand(args.mongoStd.draftable_sum_to_league_budget_ratio)) {
    reasons.push(
      `mongo_draftable_budget_ratio_out_of_band:${args.mongoStd.draftable_sum_to_league_budget_ratio.toFixed(4)}`
    );
  }
  if (args.rosterStd.ok && !ratioBand(args.rosterStd.draftable_sum_to_league_budget_ratio)) {
    reasons.push(
      `roster_draftable_budget_ratio_out_of_band:${args.rosterStd.draftable_sum_to_league_budget_ratio.toFixed(4)}`
    );
  }

  const idAudit = rosterUniverseWritePlayerIdAudit(args.rosterPool);
  if (!idAudit.roster_valuation_player_ids_objectid_free) {
    reasons.push(
      `roster_pool_has_objectid_like_player_ids:${idAudit.invalid_player_id_examples.slice(0, 5).join(",")}`
    );
  }

  const rosterPid = new Set(args.rosterPool.map((p) => getPlayerId(p)));
  for (const mlbId of args.spotlightMlbIds) {
    if (!rosterPid.has(String(mlbId))) {
      reasons.push(`spotlight_missing_from_roster_universe_pool:${mlbId}`);
    }
  }

  const missingSpot = args.spotlight.filter((s) => s.roster_auction_value == null);
  if (missingSpot.length > 0) {
    reasons.push(`spotlight_missing_roster_valuation:${missingSpot.map((s) => s.mlbId).join(",")}`);
  }

  const spotlightTooCheap = args.spotlight.filter(
    (s) =>
      s.mongo_auction_value != null &&
      s.mongo_auction_value >= 8 &&
      s.roster_auction_value != null &&
      s.roster_auction_value < 1.5
  );
  if (spotlightTooCheap.length > 0) {
    reasons.push(`spotlight_collapsed_vs_mongo:${spotlightTooCheap.map((s) => s.mlbId).join(",")}`);
  }

  const bigDrawdowns = args.starSample.filter(
    (s) => s.pct_change_vs_mongo != null && s.pct_change_vs_mongo < -0.38
  );
  if (bigDrawdowns.length > maxBigDrawdowns) {
    reasons.push(`many_top25_stars_drawdown_gt_38pct:${bigDrawdowns.length}`);
  }

  const starBoth = args.starSample.filter((s) => s.pct_change_vs_mongo != null);
  const starMeanAbs =
    starBoth.length > 0
      ? starBoth.reduce((acc, x) => acc + Math.abs(x.pct_change_vs_mongo ?? 0), 0) / starBoth.length
      : null;
  const starOk = starMeanAbs == null || starMeanAbs <= starMeanMax;
  if (!starOk && starMeanAbs != null) {
    reasons.push(`star_mean_abs_pct_change_above_threshold:${starMeanAbs.toFixed(4)}>${starMeanMax}`);
  }

  const useExplain = args.mongoExplainOk && args.rosterExplainOk && args.mongoExplainVals && args.rosterExplainVals;
  if (!useExplain) {
    softWarnings.push(
      "collapse_detail_partial: explain_valuation_rows valuation failed or was skipped — replacement/surplus fields may be null; classifications still use baseline heuristics."
    );
  }

  const mongoForCollapse = useExplain ? args.mongoExplainVals! : args.mongoStandardVals;
  const rosterForCollapse = useExplain ? args.rosterExplainVals! : args.rosterStandardVals;

  const collapsed = buildMongoToFloorCollapseRows({
    mongoVals: mongoForCollapse,
    rosterVals: rosterForCollapse,
    floorMax: floorDollars,
  });

  const collapse20 = collapsed.filter((c) => c.old_auction_value >= 20).length;
  const collapse10 = collapsed.length;
  if (collapse20 > 0) {
    reasons.push(`collapse_20_to_floor_nonzero:${collapse20}`);
  }

  const counts: Record<CollapseClassification, number> = {
    expected_wider_pool: 0,
    suspicious_projection_artifact: 0,
    position_replacement_artifact: 0,
  };
  for (const c of collapsed) {
    counts[c.collapse_classification]++;
  }

  const overlap = top25AuctionPlayerOverlapFromValuations(args.mongoStandardVals, args.rosterStandardVals);

  const safe = reasons.length === 0;
  const requiresReview = !safe || collapse10 > 0;

  return {
    safe_to_enable_writes: safe,
    requires_review: requiresReview,
    reasons,
    soft_warnings: softWarnings,
    collapse_20_to_floor_count: collapse20,
    collapse_10_to_floor_count: collapse10,
    collapsed_players: collapsed,
    collapse_classification_counts: counts,
    top25_auction_overlap_count: overlap.overlap_count,
    top25_mongo_only_player_ids: overlap.mongo_only_player_ids,
    top25_roster_only_player_ids: overlap.roster_only_player_ids,
    roster_valuation_player_ids_objectid_free: idAudit.roster_valuation_player_ids_objectid_free,
    invalid_player_id_examples: idAudit.invalid_player_id_examples,
    star_mean_abs_pct_change_vs_roster: starMeanAbs,
    star_mean_abs_pct_below_threshold: starOk,
    thresholds: {
      draftable_budget_ratio_low: ratioLow,
      draftable_budget_ratio_high: ratioHigh,
      star_mean_abs_pct_max: starMeanMax,
      max_top25_star_drawdowns_lt_neg_38pct: maxBigDrawdowns,
      collapse_20_to_floor_max_for_safe: 0,
      auction_floor_le_dollars: floorDollars,
    },
  };
}
