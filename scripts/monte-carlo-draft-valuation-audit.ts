/**
 * Monte Carlo draft-state valuation stress audit (Mongo catalog).
 *
 * Usage:
 *   pnpm audit:monte-carlo-valuations
 *   pnpm audit:monte-carlo-valuations -- --drafts=50
 *
 * Picks between checkpoints use catalog heuristics (ADP / catalog.value) so we only
 * run full `executeValuationWorkflow` at each checkpoint (not every pick).
 *
 * Writes tmp/monte-carlo-valuation-audit.json (tmp/ gitignored).
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import type { DraftedPlayer, LeanPlayer, ValuedPlayer, ValuationResponse } from "../src/types/brain";
import type { NormalizedValuationInput } from "../src/types/valuation";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { getPlayerId } from "../src/lib/playerId";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import {
  buildDraftroomStandardValuationInput,
  draftroomUiDefaultRoster,
} from "../src/lib/calibrationDraftroomFixture";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { playerTokensFromLean } from "../src/lib/fantasyPositioning";
import { valuationHitterPitcherBucket } from "../src/lib/valuationHitterPitcherBucket";
import { computeRemainingLeagueRosterSlots } from "../src/lib/remainingLeagueRosterSlots";

const ROOT = path.resolve(__dirname, "..");

type Strategy =
  | "adp_heavy"
  | "auction_heavy"
  | "team_adj_heavy"
  | "hybrid"
  | "scarcity"
  | "noisy_adp";

type CheckpointLabel = "pick_0" | "pick_25" | "pick_75" | "pick_150" | "pick_end";

interface CheckpointSnapshot {
  label: CheckpointLabel;
  pick_count: number;
  strategy: Strategy;
  draft_index: number;
  top25_auction: { player_id: string; name: string; position: string; auction_value: number }[];
  top25_rec_bid: { player_id: string; name: string; position: string; recommended_bid: number }[];
  top25_team_adj: { player_id: string; name: string; position: string; team_adjusted_value: number }[];
  hitter_pitcher_split: { hitterShare: number; pitcherShare: number } | null;
  by_position_auction_sum: Record<string, number>;
  counts_ge: { ge50: number; ge40: number; ge30: number; ge20: number };
  near_one_dollar: number;
  sum_all_auction: number;
  league_budget: number;
  ratio_sum_auction_to_budget: number;
  sum_top_draftable_auction: number | null;
  ratio_top_draftable_to_budget_remaining: number | null;
  total_budget_remaining: number | null;
  valuation_context: ValuationResponse["valuation_context"] | null;
  valuation_context_warnings: string[] | null;
  scoring_category_warnings: string[] | null;
}

interface OddityRecord {
  type: string;
  draft_index: number;
  strategy: Strategy;
  checkpoint: CheckpointLabel;
  detail: string;
  explanation?: Record<string, unknown>;
}

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function snakeTeamIndex(pickIndex: number, numTeams: number): number {
  const round = Math.floor(pickIndex / numTeams);
  const pos = pickIndex % numTeams;
  return round % 2 === 0 ? pos : numTeams - 1 - pos;
}

function rosterSlotsTotal(slots: { count: number }[]): number {
  return slots.reduce((s, r) => s + (r.count ?? 0), 0);
}

function computeBudgetByTeam(
  numTeams: number,
  totalPerTeam: number,
  drafted: DraftedPlayer[]
): Record<string, number> {
  const spent = new Array(numTeams).fill(0) as number[];
  for (const d of drafted) {
    const m = /^team_(\d+)$/.exec((d.team_id ?? "").trim());
    if (!m) continue;
    const idx = parseInt(m[1]!, 10) - 1;
    if (idx >= 0 && idx < numTeams) spent[idx] += d.paid ?? 0;
  }
  const map: Record<string, number> = {};
  for (let i = 0; i < numTeams; i++) {
    map[`team_${i + 1}`] = Math.max(0, totalPerTeam - spent[i]!);
  }
  return map;
}

function buildPositionOverrides(pool: LeanPlayer[]): { player_id: string; positions: string[] }[] {
  const out: { player_id: string; positions: string[] }[] = [];
  for (const p of pool) {
    const tok = playerTokensFromLean(p, undefined);
    if (tok.length === 0) continue;
    out.push({ player_id: getPlayerId(p), positions: tok });
  }
  return out;
}

function poolById(pool: LeanPlayer[]): Map<string, LeanPlayer> {
  const m = new Map<string, LeanPlayer>();
  for (const p of pool) {
    m.set(getPlayerId(p), p);
  }
  return m;
}

function classifyRow(
  row: ValuedPlayer,
  byId: Map<string, LeanPlayer>,
  ov: ReturnType<typeof positionOverridesFromRequest>
): "hitter" | "pitcher" {
  const lp = byId.get(row.player_id);
  return valuationHitterPitcherBucket(row, lp, ov ?? undefined);
}

function pickStrategy(rng: () => number): Strategy {
  const r = rng();
  if (r < 0.22) return "adp_heavy";
  if (r < 0.4) return "auction_heavy";
  if (r < 0.55) return "team_adj_heavy";
  if (r < 0.72) return "hybrid";
  if (r < 0.88) return "scarcity";
  return "noisy_adp";
}

function team1NeedWeights(
  drafted: DraftedPlayer[],
  rosterSlots: { position: string; count: number }[]
): Map<string, number> {
  const need = new Map<string, number>();
  for (const s of rosterSlots) {
    const k = s.position.toUpperCase();
    need.set(k, (need.get(k) ?? 0) + (s.count ?? 0));
  }
  for (const d of drafted) {
    if (d.team_id !== "team_1") continue;
    const pos = (d.position ?? "").split(/[,/]/)[0]?.trim().toUpperCase() ?? "";
    if (pos && need.has(pos)) need.set(pos, Math.max(0, (need.get(pos) ?? 1) - 1));
    if (pos === "LF" || pos === "CF" || pos === "RF") {
      need.set("OF", Math.max(0, (need.get("OF") ?? 3) - 1));
    }
  }
  const w = new Map<string, number>();
  for (const [k, v] of need) {
    if (v > 0) w.set(k, 1 + v * 2);
  }
  return w;
}

/** Proxy pick between checkpoints (no full valuation). */
function selectPickIndexProxy(
  strategy: Strategy,
  undrafted: LeanPlayer[],
  rng: () => number,
  drafted: DraftedPlayer[],
  rosterSlots: { position: string; count: number }[]
): number {
  const scored = undrafted.map((p, i) => {
    const catVal = Number.isFinite(p.value) ? p.value : 0;
    const rank =
      Number.isFinite(p.catalog_rank) &&
      p.catalog_rank > 0 &&
      p.catalog_rank < 9999
        ? p.catalog_rank
        : 9999;
    return { i, p, catVal, adp: rank };
  });
  if (scored.length === 0) return 0;

  if (strategy === "adp_heavy" || strategy === "noisy_adp") {
    scored.sort((a, b) => a.adp - b.adp);
    const window = Math.min(16, scored.length - 1);
    const bias = strategy === "noisy_adp" ? rng() : rng() * rng();
    const j = Math.floor(bias * (window + 1));
    return scored[j]!.i;
  }

  if (strategy === "auction_heavy" || strategy === "team_adj_heavy") {
    scored.sort((a, b) => b.catVal - a.catVal);
    const window = Math.min(12, scored.length - 1);
    const j = Math.floor((0.3 + 0.7 * rng()) * (window + 1));
    return scored[j]!.i;
  }

  if (strategy === "hybrid") {
    const byAdp = [...scored].sort((a, b) => a.adp - b.adp);
    const byVal = [...scored].sort((a, b) => b.catVal - a.catVal);
    const adpPos = new Map(byAdp.map((x, idx) => [x.i, idx]));
    const valPos = new Map(byVal.map((x, idx) => [x.i, idx]));
    let best = scored[0]!;
    let bestScore = Infinity;
    for (const x of scored) {
      const s = (adpPos.get(x.i) ?? 0) * 0.5 + (valPos.get(x.i) ?? 0) * 0.5 + rng() * 4;
      if (s < bestScore) {
        bestScore = s;
        best = x;
      }
    }
    return best.i;
  }

  const needW = team1NeedWeights(drafted, rosterSlots);
  scored.sort((a, b) => b.catVal - a.catVal);
  let best = scored[0]!;
  let bestScore = -1;
  for (const x of scored.slice(0, 50)) {
    const pos = (x.p.position ?? "").toUpperCase().split(/[,/]/)[0] ?? "";
    const ofTok = pos.includes("LF") || pos.includes("CF") || pos.includes("RF") || pos === "OF";
    const slotKey = ofTok ? "OF" : pos;
    const boost = needW.get(slotKey) ?? (ofTok ? needW.get("OF") : undefined) ?? 0;
    const sc = x.catVal * (1 + boost * 0.06) + rng() * 3;
    if (sc > bestScore) {
      bestScore = sc;
      best = x;
    }
  }
  return best.i;
}

function simulatePicksToCount(
  pool: LeanPlayer[],
  targetCount: number,
  strategy: Strategy,
  rng: () => number,
  slots: { position: string; count: number }[],
  totalPerTeam: number
): DraftedPlayer[] {
  const drafted: DraftedPlayer[] = [];
  while (drafted.length < targetCount) {
    const undrafted = pool.filter((p) => !drafted.some((d) => d.player_id === getPlayerId(p)));
    if (undrafted.length === 0) break;
    const idx = selectPickIndexProxy(strategy, undrafted, rng, drafted, slots);
    const p = undrafted[idx] ?? undrafted[0]!;
    const teamIdx = snakeTeamIndex(drafted.length, 12);
    const tid = `team_${teamIdx + 1}`;
    const budgetLeft = computeBudgetByTeam(12, totalPerTeam, drafted)[tid] ?? 0;
    const cat = Number.isFinite(p.value) ? p.value : 10;
    const paid = Math.max(
      1,
      Math.min(Math.round(cat * (0.2 + rng() * 0.15)), Math.max(1, budgetLeft - 1))
    );
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

function buildSnapshot(
  label: CheckpointLabel,
  pickCount: number,
  strategy: Strategy,
  draftIndex: number,
  pool: LeanPlayer[],
  input: NormalizedValuationInput,
  res: { ok: true; response: ValuationResponse }
): CheckpointSnapshot {
  const { response } = res;
  const rows = response.valuations;
  const byId = poolById(pool);
  const ov = positionOverridesFromRequest(input.position_overrides);
  let hit = 0;
  let pit = 0;
  for (const r of rows) {
    if (classifyRow(r, byId, ov) === "hitter") hit += r.auction_value;
    else pit += r.auction_value;
  }
  const hp = hit + pit;
  const sortedA = [...rows].sort((a, b) => b.auction_value - a.auction_value);
  const sortedR = [...rows]
    .filter((r) => r.recommended_bid != null)
    .sort((a, b) => (b.recommended_bid ?? 0) - (a.recommended_bid ?? 0));
  const sortedT = [...rows]
    .filter((r) => r.team_adjusted_value != null)
    .sort((a, b) => (b.team_adjusted_value ?? 0) - (a.team_adjusted_value ?? 0));
  const byPos: Record<string, number> = {};
  for (const r of rows) {
    const k = (r.position ?? "UNK").toUpperCase();
    byPos[k] = (byPos[k] ?? 0) + r.auction_value;
  }
  const leagueBudget = input.total_budget * input.num_teams;
  const sumAll = rows.reduce((s, r) => s + r.auction_value, 0);
  const dps = response.draftable_pool_size ?? 0;
  const topDraft =
    dps > 0
      ? [...rows].sort((a, b) => b.auction_value - a.auction_value).slice(0, dps).reduce((s, r) => s + r.auction_value, 0)
      : null;
  const rem = response.total_budget_remaining ?? null;
  return {
    label,
    pick_count: pickCount,
    strategy,
    draft_index: draftIndex,
    top25_auction: sortedA.slice(0, 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      auction_value: r.auction_value,
    })),
    top25_rec_bid: sortedR.slice(0, 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      recommended_bid: r.recommended_bid ?? 0,
    })),
    top25_team_adj: sortedT.slice(0, 25).map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      team_adjusted_value: r.team_adjusted_value ?? 0,
    })),
    hitter_pitcher_split:
      hp > 0
        ? { hitterShare: hit / hp, pitcherShare: pit / hp }
        : null,
    by_position_auction_sum: byPos,
    counts_ge: {
      ge50: rows.filter((r) => r.auction_value >= 50).length,
      ge40: rows.filter((r) => r.auction_value >= 40).length,
      ge30: rows.filter((r) => r.auction_value >= 30).length,
      ge20: rows.filter((r) => r.auction_value >= 20).length,
    },
    near_one_dollar: rows.filter((r) => r.auction_value <= 1.05).length,
    sum_all_auction: sumAll,
    league_budget: leagueBudget,
    ratio_sum_auction_to_budget: leagueBudget > 0 ? sumAll / leagueBudget : 0,
    sum_top_draftable_auction: topDraft,
    ratio_top_draftable_to_budget_remaining:
      topDraft != null && rem != null && rem > 0 ? topDraft / rem : null,
    total_budget_remaining: rem,
    valuation_context: response.valuation_context ?? null,
    valuation_context_warnings: response.valuation_context_warnings ?? null,
    scoring_category_warnings: response.scoring_category_warnings ?? null,
  };
}

function detectAdjacentCheckpointOddities(
  prev: CheckpointSnapshot,
  cur: CheckpointSnapshot,
  draftedIds: Set<string>
): OddityRecord[] {
  const out: OddityRecord[] = [];
  const prevMap = new Map(prev.top25_auction.map((r) => [r.player_id, r.auction_value]));
  for (const row of cur.top25_auction.slice(0, 25)) {
    const pav = prevMap.get(row.player_id);
    if (pav == null || pav < 2) continue;
    const ratio = row.auction_value / pav;
    const jump = row.auction_value - pav;
    // Large ratio swings are often legitimate repricing as stars leave the pool; only flag
    // material moves (avoid noise on small-dollar rows or proxy-draft artifacts).
    if (
      (ratio > 2.75 || ratio < 0.36) &&
      Math.min(pav, row.auction_value) >= 6 &&
      Math.abs(jump) >= 10
    ) {
      out.push({
        type: "auction_value_mult_checkpoint",
        draft_index: cur.draft_index,
        strategy: cur.strategy,
        checkpoint: cur.label,
        detail: `${row.name} auction ${pav.toFixed(2)} -> ${row.auction_value.toFixed(2)} (ratio ${ratio.toFixed(2)})`,
        explanation: { player_id: row.player_id, prev: pav, cur: row.auction_value },
      });
    }
    if (jump > 15 && Math.min(pav, row.auction_value) >= 8) {
      out.push({
        type: "auction_value_jump_15",
        draft_index: cur.draft_index,
        strategy: cur.strategy,
        checkpoint: cur.label,
        detail: `${row.name} +$${jump.toFixed(2)} over ${cur.pick_count - prev.pick_count} picks`,
        explanation: { player_id: row.player_id, prev: pav, cur: row.auction_value },
      });
    }
  }
  const top = cur.top25_auction[0];
  if (top) {
    const ptsr = cur.valuation_context?.pool_to_slot_ratio ?? null;
    const warns = cur.valuation_context_warnings ?? [];
    if (top.auction_value > 75 && (ptsr == null || ptsr > 1.8) && warns.length === 0) {
      out.push({
        type: "high_top_player_no_warn",
        draft_index: cur.draft_index,
        strategy: cur.strategy,
        checkpoint: cur.label,
        detail: `${top.name} $${top.auction_value.toFixed(2)} top; pool_to_slot=${ptsr}`,
      });
    }
  }
  for (const row of cur.top25_auction) {
    if (row.auction_value <= 1.05 && !draftedIds.has(row.player_id)) {
      out.push({
        type: "top_list_floor_dollar",
        draft_index: cur.draft_index,
        strategy: cur.strategy,
        checkpoint: cur.label,
        detail: `${row.name} in top-25 auction list at $${row.auction_value.toFixed(2)}`,
      });
    }
  }
  return out;
}

function detectSnapshotOddities(
  snap: CheckpointSnapshot,
  rows: ValuedPlayer[],
  drafted: DraftedPlayer[]
): OddityRecord[] {
  const out: OddityRecord[] = [];
  const draftedSet = new Set(drafted.map((d) => d.player_id));
  const team1 = drafted.filter((d) => d.team_id === "team_1");
  const openRough = team1.length < 8;
  if (openRough && snap.pick_count >= 40) {
    let same = 0;
    let diff = 0;
    for (const r of rows) {
      if (draftedSet.has(r.player_id)) continue;
      const ta = r.team_adjusted_value ?? r.auction_value;
      if (Math.abs(ta - r.auction_value) < 0.05) same++;
      else diff++;
    }
    if (same > diff && rows.length > 50) {
      out.push({
        type: "team_adj_equals_auction_despite_needs",
        draft_index: snap.draft_index,
        strategy: snap.strategy,
        checkpoint: snap.label,
        detail: `team_1 picks=${team1.length}; many undrafted rows TA≈AV`,
      });
    }
  }
  const hp = snap.hitter_pitcher_split;
  if (hp && snap.pick_count === 0 && hp.pitcherShare > 0.42) {
    out.push({
      type: "pitcher_heavy_board_start",
      draft_index: snap.draft_index,
      strategy: snap.strategy,
      checkpoint: snap.label,
      detail: `pitcher share ${(100 * hp.pitcherShare).toFixed(1)}% at draft start`,
    });
  }
  const scw = snap.scoring_category_warnings ?? [];
  const vcw = snap.valuation_context_warnings ?? [];
  const pt = snap.valuation_context?.pool_to_slot_ratio ?? null;
  if (scw.length > 0 && vcw.length === 0 && pt != null && pt < 2.0) {
    out.push({
      type: "scoring_warn_no_context_warn_tight_pool",
      draft_index: snap.draft_index,
      strategy: snap.strategy,
      checkpoint: snap.label,
      detail: `scoring warnings set but no context warnings; pool_to_slot=${pt}`,
    });
  }
  return out;
}

async function explainBundleForPlayer(
  pool: LeanPlayer[],
  baseInput: NormalizedValuationInput,
  drafted: DraftedPlayer[],
  playerId: string
): Promise<Record<string, unknown> | null> {
  const input: NormalizedValuationInput = {
    ...baseInput,
    drafted_players: drafted,
    explain_valuation_rows: true,
  };
  const res = executeValuationWorkflow(pool, input, {}, { debugSignals: true });
  if (!res.ok) return { error: res.issues };
  const r = res.response.valuations.find((v) => v.player_id === playerId);
  if (!r) return null;
  const lp = poolById(pool).get(playerId);
  const ex = r.valuation_explain;
  const dbg = r.debug_v2;
  return {
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    effective_positions: ex?.effective_positions,
    team: lp?.team ?? r.team,
    age: lp?.age,
    depthChartPosition: lp?.depthChartPosition,
    injurySeverity: lp?.injurySeverity,
    baseline_value: r.baseline_value,
    auction_value: r.auction_value,
    recommended_bid: r.recommended_bid,
    team_adjusted_value: r.team_adjusted_value,
    replacement_key_used: ex?.replacement_key_used ?? dbg?.replacement_key_used,
    replacement_value_used: ex?.replacement_value_used ?? dbg?.replacement_value_used,
    surplus_basis: ex?.surplus_basis ?? dbg?.surplus_basis,
    inflation_factor: r.inflation_factor,
    pool_size: ex?.pool_size,
    roster_demand_slots: ex?.roster_demand_slots,
    pool_to_slot_ratio: ex?.pool_to_slot_ratio,
    valuation_context_warnings: res.response.valuation_context_warnings,
    scoring_category_warnings: res.response.scoring_category_warnings,
  };
}

function parseArgs(argv: string[]): { drafts: number } {
  let drafts = 100;
  for (const a of argv.filter((x) => x !== "--")) {
    if (a.startsWith("--drafts=")) {
      const n = parseInt(a.slice("--drafts=".length), 10);
      if (Number.isFinite(n) && n > 0) drafts = Math.min(5000, n);
    }
  }
  return { drafts };
}

async function rosterShapeSanity(
  pool: LeanPlayer[],
  positionOverrides: { player_id: string; positions: string[] }[],
  drafted75: DraftedPlayer[]
): Promise<Record<string, unknown>> {
  const base = buildDraftroomStandardValuationInput({
    user_team_id: "team_1",
    position_overrides: positionOverrides,
    drafted_players: drafted75,
  });
  const std = executeValuationWorkflow(pool, base, {});
  const twoC = executeValuationWorkflow(pool, {
    ...base,
    roster_slots: draftroomUiDefaultRoster().map((s) =>
      s.position === "C" ? { ...s, count: 2 } : s
    ),
  });
  const fiveOf = executeValuationWorkflow(pool, {
    ...base,
    roster_slots: draftroomUiDefaultRoster().map((s) =>
      s.position === "OF" ? { ...s, count: 5 } : s
    ),
  });
  const topC = (res: typeof std) => {
    if (!res.ok) return null;
    const cs = res.response.valuations
      .filter((v) => (v.position ?? "").toUpperCase() === "C")
      .sort((a, b) => b.auction_value - a.auction_value)[0];
    return cs ? { name: cs.name, player_id: cs.player_id, auction_value: cs.auction_value } : null;
  };
  const sumOf = (res: typeof std) => {
    if (!res.ok) return 0;
    return res.response.valuations
      .filter((v) => {
        const p = (v.position ?? "").toUpperCase();
        return p.includes("OF") || p === "LF" || p === "CF" || p === "RF";
      })
      .sort((a, b) => b.auction_value - a.auction_value)
      .slice(0, 5)
      .reduce((s, v) => s + v.auction_value, 0);
  };
  const c1 = topC(std);
  const c2 = topC(twoC);
  const top5Of1 = sumOf(std);
  const top5Of5 = sumOf(fiveOf);
  /** Top-5 OF $ sums are typically ~85–90; allow small slack for MC noise / list composition at the same draft checkpoint. */
  const ofTop5SumSlack = 1.25;
  return {
    shared_draft_picks: drafted75.length,
    top_catcher_1c: c1,
    top_catcher_2c: c2,
    top5_of_auction_sum_1of: top5Of1,
    top5_of_auction_sum_5of: top5Of5,
    catcher_rise_ok: c1 && c2 ? c2.auction_value > c1.auction_value - 0.01 : null,
    of_rise_ok: std.ok && fiveOf.ok ? top5Of5 + ofTop5SumSlack >= top5Of1 : null,
  };
}

async function adjustmentAudit(pool: LeanPlayer[]): Promise<Record<string, unknown>> {
  const withAge = pool.filter((p) => (p.age ?? 0) > 0);
  const withDepth = pool.filter((p) => p.depthChartPosition != null && p.depthChartPosition !== 0);
  const withInj = pool.filter((p) => (p.injurySeverity ?? 0) > 0);
  const sample = [...pool]
    .filter((p) => (p.age ?? 0) > 30 || (p.injurySeverity ?? 0) > 0)
    .slice(0, 12);
  const base = buildDraftroomStandardValuationInput({ user_team_id: "team_1" });
  const res = executeValuationWorkflow(pool, base, {}, { debugSignals: true });
  const explainGaps: string[] = [];
  if (!res.ok) {
    return { error: res.issues };
  }
  for (const p of sample) {
    const id = getPlayerId(p);
    const row = res.response.valuations.find((v) => v.player_id === id);
    const bc = row?.baseline_components;
    if (!bc && (p.age ?? 0) > 0) {
      explainGaps.push(`${p.name}: age=${p.age} but no baseline_components on row`);
    }
  }
  return {
    catalog_counts: {
      with_age: withAge.length,
      with_depth_chart: withDepth.length,
      with_injury_flag: withInj.length,
    },
    note:
      "Age/depth/injury feed the baseline engine; row-level baseline_components may be absent on the response contract.",
    explainability_sample_notes: explainGaps.slice(0, 8),
  };
}

async function main(): Promise<void> {
  const { drafts: numDrafts } = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let pool: LeanPlayer[];
  try {
    pool = await loadMongoCatalogForEngine(undefined, {
      skipMlbHydration: process.env.AMETHYST_SKIP_MLB_TEAM_HYDRATE === "1",
    });
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const positionOverrides = buildPositionOverrides(pool);
  const slots = draftroomUiDefaultRoster();
  const slotsPerTeam = rosterSlotsTotal(slots);
  const capacity = computeRemainingLeagueRosterSlots(slots, 12, [], []);
  const endPick = Math.min(pool.length, slotsPerTeam * 12, capacity);

  const checkpoints: number[] = [0, 25, 75, 150];
  if (endPick > 150) checkpoints.push(endPick);

  const baseTemplate = buildDraftroomStandardValuationInput({
    user_team_id: "team_1",
    position_overrides: positionOverrides,
    deterministic: true,
  });

  const allOddities: OddityRecord[] = [];
  const snapshots: CheckpointSnapshot[] = [];

  for (let d = 0; d < numDrafts; d++) {
    const rng = mulberry32(0x9e3779b9 + d * 2654435761);
    const strategy = pickStrategy(rng);
    let prevSnap: CheckpointSnapshot | null = null;
    let drafted: DraftedPlayer[] = [];

    for (const target of checkpoints) {
      const cap = Math.min(target, endPick);
      drafted = simulatePicksToCount(pool, cap, strategy, rng, slots, baseTemplate.total_budget);
      const input: NormalizedValuationInput = {
        ...baseTemplate,
        drafted_players: drafted,
        budget_by_team_id: computeBudgetByTeam(12, baseTemplate.total_budget, drafted),
        seed: 10007 + d * 7919 + cap,
      };
      const res = executeValuationWorkflow(pool, input, {}, {});
      if (!res.ok) continue;
      const label: CheckpointLabel =
        cap === 0
          ? "pick_0"
          : cap === 25
            ? "pick_25"
            : cap === 75
              ? "pick_75"
              : cap === 150
                ? "pick_150"
                : "pick_end";
      const snap = buildSnapshot(label, drafted.length, strategy, d, pool, input, res);
      snapshots.push(snap);

      const draftedIds = new Set(drafted.map((x) => x.player_id));
      if (prevSnap) {
        allOddities.push(...detectAdjacentCheckpointOddities(prevSnap, snap, draftedIds));
      }
      allOddities.push(...detectSnapshotOddities(snap, res.response.valuations, drafted));

      prevSnap = snap;
    }
  }

  const drafted75Adp = [...pool]
    .filter(
      (p) =>
        Number.isFinite(p.catalog_rank) &&
        p.catalog_rank > 0 &&
        p.catalog_rank < 9999
    )
    .sort((a, b) => a.catalog_rank - b.catalog_rank)
    .slice(0, 75)
    .map((p, i) => ({
      player_id: getPlayerId(p),
      name: p.name,
      position: p.position,
      team: p.team ?? "",
      team_id: `team_${(i % 12) + 1}`,
      paid: 3 + (i % 5),
    }));

  const rosterSanity = await rosterShapeSanity(pool, positionOverrides, drafted75Adp);
  if (rosterSanity.catcher_rise_ok === false) {
    allOddities.push({
      type: "catcher_not_rising_2c",
      draft_index: -1,
      strategy: "adp_heavy",
      checkpoint: "pick_75",
      detail: "Top catcher auction did not increase in 2C vs 1C at same draft state",
      explanation: rosterSanity as unknown as Record<string, unknown>,
    });
  }
  if (rosterSanity.of_rise_ok === false) {
    allOddities.push({
      type: "of_not_rising_5of",
      draft_index: -1,
      strategy: "adp_heavy",
      checkpoint: "pick_75",
      detail: "Top-5 OF auction sum did not increase in 5 OF vs 3 OF",
      explanation: rosterSanity as unknown as Record<string, unknown>,
    });
  }

  const adjAudit = await adjustmentAudit(pool);

  const typeCounts = new Map<string, number>();
  const playerRisk = new Map<string, number>();
  for (const o of allOddities) {
    typeCounts.set(o.type, (typeCounts.get(o.type) ?? 0) + 1);
    const pid = o.explanation?.player_id;
    if (typeof pid === "string" && pid.length > 0) {
      playerRisk.set(pid, (playerRisk.get(pid) ?? 0) + 1);
    }
  }

  const replayDraft = simulatePicksToCount(
    pool,
    75,
    "hybrid",
    mulberry32(424242),
    slots,
    baseTemplate.total_budget
  );
  const explainBundles: Record<string, unknown>[] = [];
  const sampleIds = [...playerRisk.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id]) => id);
  for (const pid of sampleIds) {
    const b = await explainBundleForPlayer(pool, baseTemplate, replayDraft, pid);
    if (b) explainBundles.push({ sample_checkpoint: "pick_75_replay_hybrid", ...b });
  }

  const recurring = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const riskPlayers = [...playerRisk.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const oidKeys = pool.filter((p) => /^[a-f0-9]{24}$/i.test(getPlayerId(p))).length;

  const out = {
    generatedAt: new Date().toISOString(),
    summary_console: {
      drafts_simulated: numDrafts,
      valuation_snapshots: snapshots.length,
      oddities_flagged: allOddities.length,
      top_recurring_oddity_types: Object.fromEntries(recurring),
      highest_risk_player_ids: riskPlayers,
      catalog_object_id_keys: oidKeys,
      interpretation:
        "Most auction swings across checkpoints are expected when the proxy draft removes different players than a human draft would; use oddities as triage, not automatic bugs. " +
        "Dedupe Mongo rows missing mlbId (ObjectId keys) before treating player_id-level trends as gospel.",
      recommended_next_fixes: [
        "Catalog: backfill mlbId / merge duplicate-name rows (see catalog_object_id_player_keys).",
        "Optional: re-run picks with per-pick valuation for a small N to validate high-severity oddities only.",
        "Optional: tighten proxy strategies toward last-checkpoint auction ranks for less board shock between checkpoints.",
      ],
    },
    config: {
      drafts: numDrafts,
      teams: 12,
      total_budget_per_team: 260,
      inflation_model: "replacement_slots_v2",
      checkpoints,
      end_pick: endPick,
      position_override_rows: positionOverrides.length,
      catalog_object_id_keys: oidKeys,
      note_between_checkpoints:
        "Picks simulated with ADP / catalog.value proxies; full workflow only at checkpoints.",
    },
    roster_shape_sanity: rosterSanity,
    adjustment_factor_audit: adjAudit,
    oddity_count: allOddities.length,
    oddities: allOddities.slice(0, 500),
    explain_bundles_sample: explainBundles,
    summary: {
      recurring_oddity_types: Object.fromEntries(recurring),
      highest_risk_player_ids: riskPlayers,
    },
    snapshots_count: snapshots.length,
  };

  const abs = path.join(ROOT, "tmp", "monte-carlo-valuation-audit.json");
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(out, null, 2));

  const brief = {
    drafts: numDrafts,
    snapshots: snapshots.length,
    oddities: allOddities.length,
    recurring_oddity_types: Object.fromEntries(recurring),
    top_risk_player_ids: riskPlayers.slice(0, 10),
    roster_sanity: rosterSanity,
    catalog_object_id_player_keys: oidKeys,
    wrote: abs,
  };
  console.log(JSON.stringify(brief, null, 2));
  console.error("\n--- Monte Carlo summary ---");
  console.error(`Drafts: ${numDrafts}  Snapshots: ${snapshots.length}  Oddities: ${allOddities.length}`);
  console.error(`Top oddity types: ${recurring.slice(0, 5).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
  console.error(`Highest-risk player_ids: ${riskPlayers.slice(0, 6).map(([id, n]) => `${id}×${n}`).join(", ") || "(none)"}`);
  console.error(`2C / 5OF sanity: catcher_rise_ok=${rosterSanity.catcher_rise_ok} of_rise_ok=${rosterSanity.of_rise_ok}`);
  console.error(`Catalog rows using ObjectId as player_id: ${oidKeys}`);
  console.error(`JSON: ${abs}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
