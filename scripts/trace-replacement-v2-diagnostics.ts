/**
 * Deep trace for replacement_slots_v2 (read-only Mongo + in-memory patches).
 *
 *   MONGO_URI=... npx ts-node --project tsconfig.scripts.json scripts/trace-replacement-v2-diagnostics.ts
 *
 * Writes tmp/replacement-v2-trace.json
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import type { DraftedPlayer, LeanPlayer, ValuedPlayer } from "../src/types/brain";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { getPlayerId } from "../src/lib/playerId";
import { computeBudgetRemaining } from "../src/services/inflationModel";
import { computeReplacementSlotsV2 } from "../src/services/replacementSlotsV2";
import {
  buildLeagueSlotDemand,
  cloneDemandMap,
  greedyAssignLeagueSlotsMutable,
  sumDemand,
  fitsRosterSlot,
} from "../src/lib/fantasyRosterSlots";
import { buildUndraftedCandidates, buildRosteredCandidates } from "../src/services/replacementSlotsV2Helpers";
import {
  SLOT_REPLACEMENT_DEFAULT_PERCENTILE,
  SLOT_REPLACEMENT_PERCENTILE,
} from "../src/services/replacementSlotsV2Config";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { ROTO_Z_HITTER, ROTO_Z_PITCHER } from "../src/services/baselineRotoZConfig";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "replacement-v2-trace.json");

/** Mirrors `percentileFromValues` in fantasySlotAssignment.ts */
function percentileFromValues(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const p = Math.max(0, Math.min(1, percentile));
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.round((sorted.length - 1) * p);
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))] ?? 0;
}

function percentileIndex(len: number, percentile: number): number {
  if (len <= 0) return 0;
  const p = Math.max(0, Math.min(1, percentile));
  return Math.round((len - 1) * p);
}

function slotTraceMirror(
  undrafted: LeanPlayer[],
  rostered: DraftedPlayer[],
  rosterSlots: Parameters<typeof buildLeagueSlotDemand>[0],
  numTeams: number,
  baselineById: Map<string, number>,
  opts: { deterministic: boolean; seed: number }
): {
  undraftedSlotValues: Map<string, number[]>;
  assignmentsPerSlot: Record<string, number>;
  undraftedAssignedIds: Set<string>;
} {
  const rosterSlotKeys = new Set<string>();
  const initialDemand = buildLeagueSlotDemand(rosterSlots, numTeams);
  for (const k of initialDemand.keys()) rosterSlotKeys.add(k);

  const slotValues = new Map<string, number[]>();
  const demand = cloneDemandMap(initialDemand);

  const rosteredCandidates = buildRosteredCandidates(
    rostered,
    baselineById,
    opts.deterministic,
    opts.seed,
    undefined
  );

  greedyAssignLeagueSlotsMutable(
    rosteredCandidates,
    demand,
    slotValues,
    rosterSlotKeys,
    { deterministic: opts.deterministic, seed: opts.seed }
  );

  const undraftedCandidates = buildUndraftedCandidates(
    undrafted,
    opts.deterministic,
    opts.seed,
    undefined
  );
  const undraftedAssignedIds = new Set<string>();
  const undraftedSlotValues = new Map<string, number[]>();
  const assignmentsPerSlot: Record<string, number> = {};

  for (const c of undraftedCandidates) {
    if (sumDemand(demand) <= 0) break;
    const before = sumDemand(demand);
    greedyAssignLeagueSlotsMutable(
      [c],
      demand,
      slotValues,
      rosterSlotKeys,
      {
        deterministic: opts.deterministic,
        seed: opts.seed,
        onAssign: (_playerId, slotKey, baseline) => {
          const arr = undraftedSlotValues.get(slotKey) ?? [];
          arr.push(baseline);
          undraftedSlotValues.set(slotKey, arr);
          assignmentsPerSlot[slotKey] = (assignmentsPerSlot[slotKey] ?? 0) + 1;
        },
      }
    );
    const after = sumDemand(demand);
    if (after < before) undraftedAssignedIds.add(c.player_id);
  }

  return { undraftedSlotValues, assignmentsPerSlot, undraftedAssignedIds };
}

function bindingSlotForSurplus(
  baseline: number,
  tokens: readonly string[],
  repl: Record<string, number>,
  rosterSlotKeys: ReadonlySet<string>
): { slot: string | null; surplus: number } {
  let best = 0;
  let bestSlot: string | null = null;
  for (const slot of rosterSlotKeys) {
    if (!fitsRosterSlot(slot, tokens)) continue;
    const r = repl[slot] ?? 0;
    const s = baseline - r;
    if (s > best) {
      best = s;
      bestSlot = slot;
    }
  }
  return { slot: bestSlot, surplus: Math.max(0, best) };
}

function summarizeExperiment(
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
    const ov = positionOverridesFromRequest(input.position_overrides);
    const rows = res.valuations.map((r: ValuedPlayer) => ({
      player_id: r.player_id,
      auction_value: r.auction_value ?? 0,
      surplus_basis: r.valuation_explain?.surplus_basis ?? null,
      replacement_key_used: r.valuation_explain?.replacement_key_used ?? null,
    }));
    const byId = new Map(pool.map((p) => [getPlayerId(p), p]));
    let hp = 0,
      pp = 0;
    for (const r of rows) {
      const lp = byId.get(r.player_id);
      if (!lp) continue;
      if (isPitcherForBaseline(lp, ov)) pp += r.auction_value;
      else hp += r.auction_value;
    }
    const sorted = [...rows].sort((a, b) => b.auction_value - a.auction_value);
    const top = sorted[0];
    const pitchers = rows.filter((r) => {
      const lp = byId.get(r.player_id);
      return lp && isPitcherForBaseline(lp, ov);
    });
    const topP = [...pitchers].sort((a, b) => b.auction_value - a.auction_value)[0];
    const mix: Record<string, number> = {};
    for (const r of sorted.slice(0, 25)) {
      const lp = byId.get(r.player_id);
      const pos = (lp?.position ?? "?").toString().trim().toUpperCase();
      mix[pos] = (mix[pos] ?? 0) + 1;
    }
    let ge40 = 0,
      ge30 = 0,
      ge20 = 0;
    for (const r of rows) {
      if (r.auction_value >= 40) ge40++;
      if (r.auction_value >= 30) ge30++;
      if (r.auction_value >= 20) ge20++;
    }
    const leagueBudget = input.total_budget * input.num_teams;
    const sumAll = rows.reduce((s, r) => s + r.auction_value, 0);
    return {
      label,
      ok: true,
      hitter_share_auction: hp + pp > 0 ? hp / (hp + pp) : null,
      pitcher_share_auction: hp + pp > 0 ? pp / (hp + pp) : null,
      ratio_sum_to_budget: leagueBudget > 0 ? sumAll / leagueBudget : null,
      top_player: top
        ? { player_id: top.player_id, auction_value: top.auction_value }
        : null,
      top_pitcher: topP
        ? { player_id: topP.player_id, auction_value: topP.auction_value }
        : null,
      top25_positional_mix: mix,
      threshold_auction: { ge40, ge30, ge20 },
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

  const input = buildDraftroomStandardValuationInput({
    explain_valuation_rows: true,
    inflation_model: "replacement_slots_v2",
    deterministic: true,
    seed: 42,
  });

  const valuationPool = filterValuationUniverse(pool, {
    leagueScope: input.league_scope,
    eligiblePlayerIds: input.eligible_player_ids,
    excludedPlayerIds: input.excluded_player_ids,
  });
  const poolWithInjury = applyInjuryOverridesToPool(
    valuationPool,
    input.injury_overrides
  );
  const basePlayers = scoringAwareBaselinePlayers(
    poolWithInjury,
    input.scoring_format,
    input.scoring_categories,
    input.roster_slots,
    positionOverridesFromRequest(input.position_overrides)
  );

  const draftedPlayers: DraftedPlayer[] = input.drafted_players ?? [];
  const baselineById = new Map<string, number>();
  for (const p of basePlayers) {
    baselineById.set(getPlayerId(p), p.value || 0);
  }

  const draftedIds = new Set(draftedPlayers.map((d) => d.player_id));
  const undraftedFull = basePlayers.filter((p) => !draftedIds.has(getPlayerId(p)));

  const budgetRemaining = computeBudgetRemaining({
    draftedPlayers,
    totalBudgetPerTeam: input.total_budget,
    numTeams: input.num_teams,
  });

  const v2 = computeReplacementSlotsV2(
    undraftedFull,
    draftedPlayers,
    input.roster_slots,
    input.num_teams,
    budgetRemaining,
    baselineById,
    { deterministic: true, seed: 42 }
  );

  const rosterSlotKeys = new Set<string>();
  const idemand = buildLeagueSlotDemand(input.roster_slots, input.num_teams);
  for (const k of idemand.keys()) rosterSlotKeys.add(k);

  const trace = slotTraceMirror(
    undraftedFull,
    draftedPlayers,
    input.roster_slots,
    input.num_teams,
    baselineById,
    { deterministic: true, seed: 42 }
  );

  const repl = v2.replacement_values_by_slot_or_position ?? {};

  const snapSp = SLOT_REPLACEMENT_PERCENTILE.SP;
  const snapRp = SLOT_REPLACEMENT_PERCENTILE.RP;

  const spArr = trace.undraftedSlotValues.get("SP") ?? [];
  const rpArr = trace.undraftedSlotValues.get("RP") ?? [];

  const percentileProof = {
    SP: {
      n: spArr.length,
      percentile_baseline: snapSp,
      percentile_plus05: snapSp + 0.05,
      idx_baseline: percentileIndex(spArr.length, snapSp),
      idx_plus05: percentileIndex(spArr.length, snapSp + 0.05),
      replacement_dollar_baseline: percentileFromValues(spArr, snapSp),
      replacement_dollar_plus05: percentileFromValues(spArr, snapSp + 0.05),
      indices_equal:
        percentileIndex(spArr.length, snapSp) === percentileIndex(spArr.length, snapSp + 0.05),
      values_equal:
        percentileFromValues(spArr, snapSp) === percentileFromValues(spArr, snapSp + 0.05),
    },
    RP: {
      n: rpArr.length,
      percentile_baseline: snapRp,
      percentile_plus05: snapRp + 0.05,
      idx_baseline: percentileIndex(rpArr.length, snapRp),
      idx_plus05: percentileIndex(rpArr.length, snapRp + 0.05),
      replacement_dollar_baseline: percentileFromValues(rpArr, snapRp),
      replacement_dollar_plus05: percentileFromValues(rpArr, snapRp + 0.05),
      indices_equal:
        percentileIndex(rpArr.length, snapRp) === percentileIndex(rpArr.length, snapRp + 0.05),
      values_equal:
        percentileFromValues(rpArr, snapRp) === percentileFromValues(rpArr, snapRp + 0.05),
    },
  };

  const candidateById = new Map(
    buildUndraftedCandidates(undraftedFull, true, 42, undefined).map(
      (c) => [c.player_id, c] as const
    )
  );

  const surplusByBinding: Record<string, number> = {};
  for (const id of trace.undraftedAssignedIds) {
    const c = candidateById.get(id);
    if (!c) continue;
    const { slot, surplus } = bindingSlotForSurplus(
      c.baseline,
      c.tokens,
      repl,
      rosterSlotKeys
    );
    if (!slot) continue;
    surplusByBinding[slot] = (surplusByBinding[slot] ?? 0) + surplus;
  }

  const wf = executeValuationWorkflow(pool, input, {});
  if (!wf.ok) throw new Error(wf.issues.join("; "));
  const res = wf.response;
  const ov = positionOverridesFromRequest(input.position_overrides);

  const auctionByBinding: Record<string, number> = {};
  const baselineByAssignedSlotFromExplain: Record<string, { sum: number; n: number }> =
    {};

  for (const r of res.valuations) {
    const k = r.valuation_explain?.replacement_key_used ?? "UNKNOWN";
    auctionByBinding[k] = (auctionByBinding[k] ?? 0) + (r.auction_value ?? 0);
    if (k !== "UNKNOWN") {
      const b = baselineByAssignedSlotFromExplain[k] ?? { sum: 0, n: 0 };
      b.sum += r.baseline_value ?? 0;
      b.n += 1;
      baselineByAssignedSlotFromExplain[k] = b;
    }
  }

  const snapZH = { ...ROTO_Z_HITTER };
  const snapZP = { ...ROTO_Z_PITCHER };
  const snapRepl = { ...SLOT_REPLACEMENT_PERCENTILE };

  const experiments = [
    summarizeExperiment("baseline", pool, () => {}, () => {}),
    summarizeExperiment(
      "pitcher_zscale_up_15pct",
      pool,
      () => {
        Object.assign(ROTO_Z_PITCHER, { zScale: snapZP.zScale * 1.15 });
      },
      () => {
        Object.assign(ROTO_Z_PITCHER, snapZP);
      }
    ),
    summarizeExperiment(
      "hitter_zscale_down_15pct",
      pool,
      () => {
        Object.assign(ROTO_Z_HITTER, { zScale: snapZH.zScale * 0.85 });
      },
      () => {
        Object.assign(ROTO_Z_HITTER, snapZH);
      }
    ),
    summarizeExperiment(
      "OF_repl_percentile_minus_05",
      pool,
      () => {
        Object.assign(SLOT_REPLACEMENT_PERCENTILE, { OF: snapRepl.OF - 0.05 });
      },
      () => {
        Object.assign(SLOT_REPLACEMENT_PERCENTILE, snapRepl);
      }
    ),
    summarizeExperiment(
      "SP_RP_repl_percentile_plus_15",
      pool,
      () => {
        Object.assign(SLOT_REPLACEMENT_PERCENTILE, {
          SP: snapRepl.SP + 0.15,
          RP: snapRepl.RP + 0.15,
        });
      },
      () => {
        Object.assign(SLOT_REPLACEMENT_PERCENTILE, snapRepl);
      }
    ),
    summarizeExperiment(
      "D_repeat_SP_RP_plus_05",
      pool,
      () => {
        Object.assign(SLOT_REPLACEMENT_PERCENTILE, {
          SP: snapRepl.SP + 0.05,
          RP: snapRepl.RP + 0.05,
        });
      },
      () => {
        Object.assign(SLOT_REPLACEMENT_PERCENTILE, snapRepl);
      }
    ),
  ];

  const topOfSurplus = [...res.valuations]
    .filter((v) => {
      const lp = pool.find((p) => getPlayerId(p) === v.player_id);
      const pos = (lp?.position ?? "").toUpperCase();
      return ["LF", "CF", "RF", "OF"].some((x) => pos.includes(x));
    })
    .sort(
      (a, b) =>
        (b.valuation_explain?.surplus_basis ?? 0) -
        (a.valuation_explain?.surplus_basis ?? 0)
    )
    .slice(0, 20)
    .map((v) => ({
      player_id: v.player_id,
      name: v.name,
      position: v.position,
      surplus_basis: v.valuation_explain?.surplus_basis,
    }));

  const topPitSurplus = [...res.valuations]
    .filter((v) => {
      const lp = pool.find((p) => getPlayerId(p) === v.player_id);
      return lp && isPitcherForBaseline(lp, ov);
    })
    .sort(
      (a, b) =>
        (b.valuation_explain?.surplus_basis ?? 0) -
        (a.valuation_explain?.surplus_basis ?? 0)
    )
    .slice(0, 20)
    .map((v) => ({
      player_id: v.player_id,
      name: v.name,
      position: v.position,
      surplus_basis: v.valuation_explain?.surplus_basis,
    }));

  const payload = {
    generatedAt: new Date().toISOString(),
    catalog_rows: pool.length,
    eligible_after_filter: valuationPool.length,
    active_config_snapshot: {
      SLOT_REPLACEMENT_PERCENTILE: { ...SLOT_REPLACEMENT_PERCENTILE },
      SLOT_REPLACEMENT_DEFAULT_PERCENTILE,
    },
    replacement_slots_v2_meta: {
      inflation_raw: v2.inflation_raw,
      inflation_factor_precap: v2.inflation_factor_precap,
      surplus_cash: v2.surplus_cash,
      total_surplus_mass: v2.total_surplus_mass,
      draftable_pool_size: v2.draftablePoolSize,
      remaining_slots: v2.remaining_slots,
      fallback_reason: v2.fallback_reason,
      budget_remaining_league: budgetRemaining,
    },
    replacement_level_by_slot: repl,
    greedy_sim_assignments_total_by_slot: trace.assignmentsPerSlot,
    assignment_counts_note:
      "Counts are league-slot fills during greedy undrafted simulation (one increment per player-slot assignment). OF slot aggregates LF/CF/RF-eligible players competing for OF demand.",
    percentile_change_experiment_D: {
      SP_inputs: { baseline_p: snapSp, delta: 0.05 },
      RP_inputs: { baseline_p: snapRp, delta: 0.05 },
      SP: percentileProof.SP,
      RP: percentileProof.RP,
      why_D_can_noop:
        "If round((n-1)*p) is identical at p and p+0.05, or sorted[ i0 ] === sorted[ i1 ], replacement $ is unchanged — inflation and auctions match baseline.",
    },
    surplus_mass_by_binding_slot_assigned_pool: surplusByBinding,
    auction_dollars_sum_by_replacement_key_used: auctionByBinding,
    baseline_mean_by_replacement_key_used: Object.fromEntries(
      Object.entries(baselineByAssignedSlotFromExplain).map(([k, v]) => [
        k,
        v.n > 0 ? v.sum / v.n : 0,
      ])
    ),
    compare_OF_vs_SP_RP: {
      OF_greedy_assignments: trace.assignmentsPerSlot.OF ?? 0,
      SP_greedy_assignments: trace.assignmentsPerSlot.SP ?? 0,
      RP_greedy_assignments: trace.assignmentsPerSlot.RP ?? 0,
      OF_percentile_input: SLOT_REPLACEMENT_PERCENTILE.OF,
      SP_percentile_input: SLOT_REPLACEMENT_PERCENTILE.SP,
      RP_percentile_input: SLOT_REPLACEMENT_PERCENTILE.RP,
      OF_replacement_dollar: repl.OF,
      SP_replacement_dollar: repl.SP,
      RP_replacement_dollar: repl.RP,
    },
    top20_OF_surplus_basis: topOfSurplus,
    top20_pitchers_surplus_basis: topPitSurplus,
    experiments_readonly: experiments,
    dead_knobs_notes: {
      pitcher_surplus_multiplier:
        "No dedicated hook; use ROTO_Z_PITCHER / slot percentiles / roster demand.",
      recommended_bid: "Intentionally not tuned in this trace script.",
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ wrote: OUT }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
