/**
 * Stage 2 valuation confidence audit (Parts 1–8).
 *
 *   pnpm audit:stage2-confidence
 *   npx tsx scripts/stage2-valuation-confidence-audit.ts [out.json]
 *
 * Requires MONGO_URI + canonical Draft checkpoints in AmethystDraft sibling repo.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import {
  ENGINE_CHECKPOINT_IDS,
  resolveDraftCheckpointFixturePath,
} from "../src/lib/checkpointSlotReconciliation";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { sumAuctionValueForDraftablePool } from "../src/lib/rosterUniverseValuationCalibration";
import { computeReplacementSlotsV2 } from "../src/services/replacementSlotsV2";
import { getPlayerId } from "../src/lib/playerId";
import { buildRosteredPlayersForSlotEngine } from "../src/lib/rosteredPlayersForSlots";
import { computeBudgetRemaining } from "../src/services/inflationModel";
import { leagueSlotCapacity } from "../src/services/teamAdjustedValue";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";
import type { ValuedPlayer, ValuationResponse } from "../src/types/valuation";
import {
  avg,
  bucketThresholds,
  buildCatalogEnvelope,
  displayDollar,
  draftableRows,
  ENGINE_CHECKPOINTS,
  findPlayerRow,
  flagBoardShape,
  hybridDiagnostics,
  largestAdjacentDrop,
  type V2AuditMaps,
  median,
  normName,
  primaryPositionGroup,
  shelfCount,
  workflowBody,
} from "../src/lib/stage2ValuationAudit/helpers";
import { trackedCanonicalNames } from "../src/lib/stage2ValuationAudit/trackedPlayers";
import {
  fetchCheckpointValuation,
  mongoCatalogUsable,
} from "../src/lib/stage2ValuationAudit/httpEngine";

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "tmp/stage2-valuation-confidence-audit.json");
const PRE_DEPLOY_SNAPSHOT = path.resolve(
  ROOT,
  "../AmethystDraft/apps/tmp/pre-deploy-catalog-verification.json",
);

type RunResult = {
  path: "engine_fixture_direct" | "engine_draftroom_envelope" | "engine_http";
  ok: boolean;
  response?: ValuationResponse;
  issues?: unknown;
};

function runWorkflow(
  poolInj: LeanPlayer[],
  input: NormalizedValuationInput,
): RunResult {
  const out = executeValuationWorkflow(poolInj, workflowBody(input), {}, {});
  if (!out.ok) return { path: "engine_fixture_direct", ok: false, issues: out.issues };
  return { path: "engine_fixture_direct", ok: true, response: out.response };
}

function loadPreDeployDraftroomSnapshot(): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(PRE_DEPLOY_SNAPSHOT, "utf8")) as {
      valuation_by_checkpoint?: Record<string, unknown>;
    };
    return raw.valuation_by_checkpoint ?? null;
  } catch {
    return null;
  }
}

function computeV2(
  poolInj: LeanPlayer[],
  nested: NormalizedValuationInput,
  r: ValuationResponse,
) {
  const undrafted = poolInj.filter(
    (p) => !nested.drafted_players.some((d) => d.player_id === getPlayerId(p)),
  );
  return computeReplacementSlotsV2(
    undrafted,
    buildRosteredPlayersForSlotEngine(nested),
    nested.roster_slots,
    nested.num_teams,
    computeBudgetRemaining({
      draftedPlayers: nested.drafted_players,
      totalBudgetPerTeam: nested.total_budget,
      numTeams: nested.num_teams,
    }),
    new Map(r.valuations.map((v) => [v.player_id, v.baseline_value])),
    { deterministic: true, seed: 42 },
  );
}

function boardShape(
  checkpoint: string,
  r: ValuationResponse,
  draftable: ValuedPlayer[],
  sorted: ValuedPlayer[],
) {
  const vals = draftable.map((v) => v.auction_value);
  const top75 = sorted.slice(0, 75);
  const top25 = sorted.slice(0, 25);
  const drop25 = largestAdjacentDrop(top25, 25);
  const drop75 = largestAdjacentDrop(top75, 75);
  const endgameAbove20 =
    checkpoint === "after_pick_130" || checkpoint === "finished_league"
      ? vals.filter((v) => v >= 20).length
      : null;

  const metrics = {
    draftable_pool_size: r.draftable_pool_size,
    total_surplus_mass: r.total_surplus_mass,
    inflation_factor: r.inflation_factor,
    replacement_values_by_slot: r.replacement_values_by_slot_or_position,
    top25: top25.map((v, i) => ({
      rank: i + 1,
      name: v.name,
      auction_value: v.auction_value,
      display_value: displayDollar(v.auction_value),
      auction_rank: v.auction_rank,
      tier: v.valuation_explain?.auction_curve_tier,
    })),
    top75_summary: {
      count: top75.length,
      min: top75[top75.length - 1]?.auction_value ?? 0,
      max: top75[0]?.auction_value ?? 0,
      avg: avg(top75.map((v) => v.auction_value)),
    },
    max_auction: sorted[0]?.auction_value ?? 0,
    top5_avg: avg(sorted.slice(0, 5).map((v) => v.auction_value)),
    top10_avg: avg(sorted.slice(0, 10).map((v) => v.auction_value)),
    top25_avg: avg(top25.map((v) => v.auction_value)),
    median_draftable: median(vals),
    buckets: bucketThresholds(vals),
    largest_drop_top25: drop25.drop,
    largest_drop_top25_ranks: `${drop25.fromRank}→${drop25.toRank}`,
    largest_drop_top75: drop75.drop,
    largest_drop_top75_ranks: `${drop75.fromRank}→${drop75.toRank}`,
    plateau_at_48: shelfCount(vals, 48),
    shelf_at_32: shelfCount(vals, 32),
    shelf_at_15: shelfCount(vals, 15),
    endgame_above_20: endgameAbove20,
    min_bid_count: vals.filter((v) => v <= 1.05).length,
    no_value_count: vals.filter((v) => v < 0.01).length,
    flags: [] as string[],
  };
  metrics.flags = flagBoardShape(metrics);
  return metrics;
}

function positionEconomics(
  draftable: ValuedPlayer[],
  v2: V2AuditMaps,
  replacement: Record<string, number>,
) {
  const groups = [
    "C",
    "1B",
    "2B",
    "3B",
    "SS",
    "MI",
    "CI",
    "OF",
    "UTIL",
    "SP",
    "RP",
    "P",
  ] as const;
  const byGroup = new Map<string, ValuedPlayer[]>();
  for (const g of groups) byGroup.set(g, []);

  for (const v of draftable) {
    const slot =
      v2.playerIdToAssignedSlot?.get(v.player_id) ??
      v.valuation_explain?.replacement_key_used ??
      v.position;
    const g = primaryPositionGroup(
      typeof slot === "string" ? slot : undefined,
      v.position,
    );
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(v);
  }

  return groups.map((g) => {
    const rows = [...(byGroup.get(g) ?? [])].sort(
      (a, b) => b.auction_value - a.auction_value,
    );
    const avs = rows.map((r) => r.auction_value);
    const top10av = rows.slice(0, 10);
    const top10sb = [...rows]
      .sort(
        (a, b) =>
          (b.valuation_explain?.surplus_basis ?? 0) -
          (a.valuation_explain?.surplus_basis ?? 0),
      )
      .slice(0, 10);
    let maxDrop = 0;
    for (let i = 0; i < Math.min(9, rows.length - 1); i++) {
      maxDrop = Math.max(maxDrop, rows[i]!.auction_value - rows[i + 1]!.auction_value);
    }
    const hybridCount = rows.filter(
      (r) => (v2.playerIdToHybridLift?.get(r.player_id) ?? 0) > 0,
    ).length;
    const repVal = replacement[g] ?? replacement[g === "RP" ? "P" : g] ?? null;
    return {
      group: g,
      replacement_value: repVal,
      draftable_count: rows.length,
      top10_auction: top10av.map((r) => ({
        name: r.name,
        auction_value: r.auction_value,
        surplus_basis: r.valuation_explain?.surplus_basis,
      })),
      top10_surplus_basis: top10sb.map((r) => ({
        name: r.name,
        surplus_basis: r.valuation_explain?.surplus_basis,
        auction_value: r.auction_value,
      })),
      avg_auction: avg(avs),
      median_auction: median(avs),
      above_20: avs.filter((v) => v >= 20).length,
      above_10: avs.filter((v) => v >= 10).length,
      above_5: avs.filter((v) => v >= 5).length,
      above_1: avs.filter((v) => v > 1.05).length,
      biggest_drop_off: maxDrop,
      hybrid_lift_applying_count: hybridCount,
      saturated_hint:
        hybridCount > 0 && rows.length > 0
          ? `${hybridCount}/${rows.length} with hybrid lift`
          : "none",
    };
  });
}

function playerDeepDive(
  r: ValuationResponse,
  draftable: ValuedPlayer[],
  v2: V2AuditMaps,
  nested: NormalizedValuationInput,
) {
  const draftableIds = new Set(r.draftable_player_ids ?? []);
  const allRows = r.valuations;
  return trackedCanonicalNames().map((name) => {
    const v = findPlayerRow(allRows, name) ?? findPlayerRow(draftable, name);
    if (!v) {
      return {
        name,
        valuation_row: false,
        in_draftable_pool: false,
        reason: "no_valuation_row",
      };
    }
    const ex = v.valuation_explain;
    const bc = v.baseline_components;
    const hy = hybridDiagnostics(v2, v.player_id);
    const inPool = draftableIds.has(v.player_id);
    const drafted = nested.drafted_players.some((d) => d.player_id === v.player_id);
    let reason: string | null = null;
    if (!inPool && drafted) reason = "drafted_not_in_draftable_pool";
    else if (!inPool && v.auction_value <= 1.05) reason = "outside_draftable_pool_min_bid";
    else if (!inPool) reason = "outside_draftable_pool";
    else if (v.auction_value <= 1.05) reason = "in_pool_min_bid";

    const flags: string[] = [];
    const adp = v.market_adp ?? null;
    if (adp != null && adp <= 30 && v.auction_value <= 5) {
      flags.push("high_adp_low_auction");
    }
    if ((v.baseline_value ?? 0) >= 55 && v.auction_value <= 5) {
      flags.push("high_baseline_low_auction");
    }
    const sb = ex?.surplus_basis ?? 0;
    if (sb >= 40 && v.auction_value <= 10) flags.push("high_surplus_low_auction");
    if (sb <= 5 && v.auction_value >= 25) flags.push("low_surplus_high_auction");

    return {
      name: v.name,
      player_id: v.player_id,
      valuation_row: true,
      in_draftable_pool: inPool,
      drafted,
      auction_value: v.auction_value,
      raw_auction_value: v.auction_value,
      display_value: displayDollar(v.auction_value),
      auction_rank: v.auction_rank,
      market_adp_audit_only: adp,
      baseline_value: v.baseline_value,
      surplus_basis: sb,
      assigned_slot: hy.assigned_slot ?? ex?.replacement_key_used,
      replacement_value_used: ex?.replacement_value_used,
      hybrid_lift: hy.hybrid_lift,
      slot_only_surplus_basis: hy.slot_only_surplus,
      auction_tier: ex?.auction_curve_tier,
      auction_curve_weight: ex?.auction_curve_weight,
      projection_component: bc?.projection_component,
      scarcity_component: bc?.scarcity_component,
      pool_to_slot_ratio: r.valuation_context?.pool_to_slot_ratio,
      reason,
      flags,
    };
  });
}

function rankShelfAudit(sorted: ValuedPlayer[]) {
  const top75 = sorted.slice(0, 75);
  const rows = top75.map((v, i) => {
    const prev = i > 0 ? top75[i - 1]! : null;
    return {
      auction_rank: v.auction_rank,
      name: v.name,
      raw_auction_value: v.auction_value,
      display_value: displayDollar(v.auction_value),
      delta_from_prev_rank: prev ? prev.auction_value - v.auction_value : 0,
      display_shelf_group: displayDollar(v.auction_value),
      same_display_as_prev:
        prev != null && displayDollar(prev.auction_value) === displayDollar(v.auction_value),
    };
  });
  const shelfGroups = new Map<number, number>();
  for (const r of rows) {
    shelfGroups.set(r.display_value, (shelfGroups.get(r.display_value) ?? 0) + 1);
  }
  const roundingShelves = [...shelfGroups.entries()]
    .filter(([, c]) => c >= 3)
    .map(([d, c]) => ({ display_dollar: d, count: c }));
  return { top75_rank_rows: rows, display_shelf_groups_ge3: roundingShelves };
}

function conservationAudit(
  r: ValuationResponse,
  nested: NormalizedValuationInput,
  draftable: ValuedPlayer[],
) {
  const minBid = r.min_bid ?? 1;
  const remaining = r.remaining_slots ?? 0;
  const surplusCash = r.surplus_cash ?? 0;
  const cap = leagueSlotCapacity(nested.roster_slots, nested.num_teams);
  const minReserve = remaining * minBid;
  let surplusFromRows = 0;
  for (const v of draftable) {
    surplusFromRows += Math.max(0, v.auction_value - minBid);
  }
  const { sum: draftableSum } = sumAuctionValueForDraftablePool(r.valuations, r);
  const mp = r.context_v2?.market_pressure;
  return {
    total_budget_per_team: nested.total_budget,
    num_teams: nested.num_teams,
    league_slot_capacity: cap,
    remaining_active_slots: remaining,
    min_bid_reserve: minReserve,
    surplus_cash: surplusCash,
    total_surplus_mass: r.total_surplus_mass,
    inflation_factor: r.inflation_factor,
    inflation_raw: r.inflation_raw,
    draftable_auction_sum: draftableSum,
    surplus_conservation_delta: surplusCash - surplusFromRows,
    surplus_conservation_reported: r.surplus_conservation_delta,
    market_pressure: mp ?? null,
    allocator_pressure: r.curve_inputs ?? null,
    expected_remaining_auction_dollars: surplusCash + minReserve,
    flags: [] as string[],
  };
}

function draftedPlayerAudit(
  nested: NormalizedValuationInput,
  r: ValuationResponse,
) {
  const draftableIds = new Set(r.draftable_player_ids ?? []);
  const drafted = nested.drafted_players.filter((d) => !d.is_keeper);
  const sample = drafted.slice(0, 15).map((d) => {
    const row = r.valuations.find((v) => v.player_id === d.player_id);
    return {
      name: d.name,
      player_id: d.player_id,
      paid: d.paid,
      in_draftable_pool: draftableIds.has(d.player_id),
      live_auction_value: row?.auction_value ?? null,
      auction_rank: row?.auction_rank ?? null,
    };
  });
  const stillPricedInPool = drafted.filter((d) => draftableIds.has(d.player_id));
  return {
    drafted_auction_count: drafted.length,
    drafted_still_in_draftable_pool: stillPricedInPool.length,
    sample,
    ui_expectation:
      "Draftroom Research shows paid price for drafted; live auction_value should not drive available-player pool",
    recommendation: "A",
    recommendation_rationale:
      "Keep drafted players in original tier at bottom (current Tiers pattern) but default-hide or de-emphasize in Research sort during active auction; sale price is historical context only.",
  };
}

function crossPathPreDeploySnapshot(
  httpDirect: ValuationResponse,
  preDeployCp: Record<string, unknown>,
) {
  const meta = preDeployCp.engine_meta as Record<string, unknown>;
  const deep = (preDeployCp.deep_dive_players ?? []) as Record<string, unknown>[];
  const diffs: Record<string, unknown>[] = [];
  for (const name of trackedCanonicalNames()) {
    const live = findPlayerRow(httpDirect.valuations, name);
    const snap = deep.find(
      (r) => normName(String(r.name)) === normName(name),
    );
    if (!live && !snap) continue;
    if (!live || !snap) {
      diffs.push({ name, classification: "missing_on_one_path", live: !!live, pre_deploy: !!snap });
      continue;
    }
    const avLive = Number(live.auction_value);
    const avSnap = Number(snap.auction_value);
    if (Math.abs(avLive - avSnap) > 0.05) {
      diffs.push({
        name,
        classification:
          Math.abs(avLive - avSnap) <= 0.5 ? "rounding_or_staleness" : "draftroom_catalog_envelope_vs_fixture_http",
        auction_value: { http_fixture: avLive, pre_deploy_draftroom: avSnap },
        surplus_basis: {
          http: live.valuation_explain?.surplus_basis,
          pre_deploy: snap.surplus_basis,
        },
      });
    }
  }
  return {
    http_fixture_meta: {
      draftable_pool_size: httpDirect.draftable_pool_size,
      inflation_factor: httpDirect.inflation_factor,
      total_surplus_mass: httpDirect.total_surplus_mass,
    },
    pre_deploy_draftroom_meta: meta,
    tracked_diffs: diffs,
    snapshot_generated_at: "see pre-deploy-catalog-verification.json",
  };
}

function crossPathDiff(
  direct: ValuationResponse,
  envelope: ValuationResponse,
) {
  const diffs: Record<string, unknown>[] = [];
  const tracked = trackedCanonicalNames();
  for (const name of tracked) {
    const a = findPlayerRow(direct.valuations, name);
    const b = findPlayerRow(envelope.valuations, name);
    if (!a && !b) continue;
    if (!a || !b) {
      diffs.push({ name, classification: "missing_on_one_path", direct: !!a, envelope: !!b });
      continue;
    }
    const fields = [
      "auction_value",
      "auction_rank",
      "baseline_value",
    ] as const;
    const delta: Record<string, unknown> = { name };
    let changed = false;
    for (const f of fields) {
      if (a[f] !== b[f]) {
        changed = true;
        delta[f] = { direct: a[f], envelope: b[f] };
      }
    }
    const tierA = a.valuation_explain?.auction_curve_tier;
    const tierB = b.valuation_explain?.auction_curve_tier;
    if (tierA !== tierB) {
      changed = true;
      delta.auction_curve_tier = { direct: tierA, envelope: tierB };
    }
    if (changed) {
      const mag = Math.abs(a.auction_value - b.auction_value);
      delta.classification =
        mag <= 0.01
          ? "rounding_only"
          : direct.draftable_pool_size !== envelope.draftable_pool_size
            ? "universe_size_difference"
            : "engine_path_difference";
      diffs.push(delta);
    }
  }
  return {
    direct_meta: {
      draftable_pool_size: direct.draftable_pool_size,
      inflation_factor: direct.inflation_factor,
      total_surplus_mass: direct.total_surplus_mass,
      player_ids_sent: (direct as { player_ids_sent?: string[] }).player_ids_sent
        ?.length ?? null,
    },
    envelope_meta: {
      draftable_pool_size: envelope.draftable_pool_size,
      inflation_factor: envelope.inflation_factor,
      total_surplus_mass: envelope.total_surplus_mass,
      player_ids_sent: (envelope as { player_ids_sent?: string[] })
        .player_ids_sent?.length ?? null,
    },
    tracked_diffs: diffs,
    identical_at_meta:
      direct.draftable_pool_size === envelope.draftable_pool_size &&
      Math.abs((direct.inflation_factor ?? 0) - (envelope.inflation_factor ?? 0)) < 0.0001,
  };
}

function buildVerdict(report: Record<string, unknown>): Record<string, unknown> {
  const board = report.part1_board_shape as Record<string, unknown>[];
  const allFlags = new Set<string>();
  for (const cp of board) {
    for (const f of (cp.flags as string[]) ?? []) allFlags.add(f);
  }
  const cross = report.part4_cross_path as Record<string, unknown>;
  const pre = (report.part3_tracked_players as Record<string, unknown>)[
    "pre_draft"
  ] as Record<string, unknown>[];
  const playerFlags = pre?.flatMap((p) => (p.flags as string[]) ?? []) ?? [];

  let verdict = "A";
  let rationale =
    "Stage 2 board shape is stable across checkpoints with no $48 plateau; UTIL/BN surplus fix holds.";
  const next: string[] = [];

  if (allFlags.has("plateau_at_$48") || allFlags.has("cliff_top25")) {
    verdict = "C";
    rationale = "Specific curve artifact detected (plateau or top-band cliff).";
    next.push("Inspect adaptive_surplus_v1 guardrails and tier budget for the checkpoint.");
  } else if (
    allFlags.has("star_compression") ||
    allFlags.has("endgame_inflation_above_$20") ||
    playerFlags.includes("high_adp_low_auction")
  ) {
    verdict = "B";
    rationale =
      "Directionally correct Stage 2 hybrid model; tune star mass or endgame phase without reverting UTIL/BN fix.";
    next.push("Evaluate hybrid-star auction weight and endgame phase inflation caps.");
  }

  if ((cross.tracked_diffs as unknown[])?.length > 5) {
    next.push(
      "Align Draftroom catalog envelope (player_ids + overrides) with audit direct path for consistent Research numbers.",
    );
  }

  const witt = pre?.find((p) => normName(String(p.name)) === normName("Bobby Witt Jr."));
  if (witt && Number(witt.auction_value) < 38) {
    next.push(
      "Witt remains structurally sane but top-band hybrid-star weight may be conservative — Stage 3 lever, not ADP.",
    );
  }

  return {
    verdict,
    rationale,
    recommended_next_steps: next.length ? next : ["UI: optional raw tie-break rank or cents in Research detail only."],
    stage3_levers_to_evaluate: [
      "hybrid_star_auction_weight",
      "starFraction / tier budget allocation",
      "guardrail shelf smoothing (only if true compression, not rounding)",
      "position-aware saturated-slot lift caps",
      "endgame phase tuning after pick 100",
    ],
  };
}

async function main() {
  const outPath = process.argv[2] ?? DEFAULT_OUT;
  const useHttp = !(await mongoCatalogUsable());
  let pool: LeanPlayer[] = [];
  if (!useHttp) {
    const uri = process.env.MONGO_URI!;
    await mongoose.connect(uri, scriptMongoConnectOptions());
    pool = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    await mongoose.disconnect();
  }
  const preDeployByCp = loadPreDeployDraftroomSnapshot();
  const auditMode = useHttp ? "engine_http_production" : "engine_in_process_mongo";

  const part1: Record<string, unknown>[] = [];
  const part2: Record<string, unknown> = {};
  const part3: Record<string, unknown> = {};
  const part4: Record<string, unknown> = {};
  const part5: Record<string, unknown> = {};
  const part6: Record<string, unknown> = {};
  const part7: Record<string, unknown> = {};

  for (const cp of ENGINE_CHECKPOINTS) {
    const raw = JSON.parse(
      readFileSync(resolveDraftCheckpointFixturePath(cp), "utf8"),
    );
    const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
    let r: ValuationResponse;
    let v2: ReturnType<typeof computeReplacementSlotsV2> | null = null;

    if (useHttp) {
      try {
        r = await fetchCheckpointValuation(cp);
      } catch (e) {
        part1.push({ checkpoint: cp, error: String(e) });
        continue;
      }
    } else {
      const poolInj = applyInjuryOverridesToPool(
        filterValuationUniverse(pool, { leagueScope: nested.league_scope }),
        nested.injury_overrides,
      );
      const directRun = runWorkflow(poolInj, nested);
      if (!directRun.ok || !directRun.response) {
        part1.push({ checkpoint: cp, error: directRun.issues });
        continue;
      }
      r = directRun.response;
      v2 = computeV2(poolInj, nested, r);
    }

    const v2Maps = v2 ?? {
      playerIdToHybridLift: new Map<string, number>(),
      playerIdToSlotOnlySurplusBasis: new Map<string, number>(),
      playerIdToAssignedSlot: new Map<string, string>(),
      playerIdToMarginalReplacement: new Map<string, number>(),
    };
    const draftable = draftableRows(r);
    const sorted = [...draftable].sort((a, b) => b.auction_value - a.auction_value);
    const replacement = r.replacement_values_by_slot_or_position ?? {};

    part1.push({ checkpoint: cp, ...boardShape(cp, r, draftable, sorted) });
    part2[cp] = positionEconomics(draftable, v2Maps, replacement);
    part3[cp] = playerDeepDive(r, draftable, v2Maps, nested);
    part5[cp] = rankShelfAudit(sorted);
    part6[cp] = draftedPlayerAudit(nested, r);
    part7[cp] = conservationAudit(r, nested, draftable);

    if (!useHttp) {
      const poolInj = applyInjuryOverridesToPool(
        filterValuationUniverse(pool, { leagueScope: nested.league_scope }),
        nested.injury_overrides,
      );
      const envelopeRun = runWorkflow(poolInj, buildCatalogEnvelope(nested, poolInj));
      if (envelopeRun.ok && envelopeRun.response) {
        part4[cp] = crossPathDiff(r, envelopeRun.response);
      }
    } else if (preDeployByCp?.[cp]) {
      part4[cp] = crossPathPreDeploySnapshot(r, preDeployByCp[cp] as Record<string, unknown>);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    audit_mode: auditMode,
    engine: "replacement_slots_v2 + adaptive_surplus_v1 (Stage 2)",
    fixture_source: "AmethystDraft canonical nested checkpoints",
    checkpoints: ENGINE_CHECKPOINT_IDS,
    part1_board_shape: part1,
    part2_position_economics: part2,
    part3_tracked_players: part3,
    part4_cross_path: part4,
    part5_rank_shelf: part5,
    part6_drafted_players: part6,
    part7_conservation: part7,
    part8_verdict: null as unknown,
    part9_notes: {
      research_command_center:
        "Read-only: compare Research/Command Center via Draftroom BFF when demo league + AMETHYST_API_URL available; this script compares engine_fixture_direct vs engine_draftroom_envelope (catalog player_ids + overrides).",
      adp: "audit-only in part3; never used as input",
    },
  };
  report.part8_verdict = buildVerdict(report);

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ wrote: outPath, verdict: report.part8_verdict }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
