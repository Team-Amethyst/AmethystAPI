/**
 * One-off / CI-adjunct: deep valuation walkthrough metrics (Mongo).
 * Run: `pnpm valuation-walkthrough` (writes `tmp/real-walkthrough-scenarios.json`, including `trust_engine_report`).
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import type { LeanPlayer, NormalizedValuationInput, ValuedPlayer, ValuationResponse } from "../src/types/brain";
import {
  buildDraftroomStandardValuationInput,
  CALIBRATION_CATS_5X5,
  CALIBRATION_CATS_QS_REPLACES_W,
  CALIBRATION_CATS_SAVES_ONLY,
  draftroomUiDefaultRoster,
} from "../src/lib/calibrationDraftroomFixture";
import { buildPitcherHarnessSplits } from "../src/lib/valuationHarnessPitcherSplits";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { computeRemainingLeagueRosterSlots } from "../src/lib/remainingLeagueRosterSlots";

const ROOT = path.resolve(__dirname, "..");

function sliceInjuryExplain(ex: ValuedPlayer["valuation_explain"]): Record<string, unknown> | null {
  if (!ex) return null;
  return {
    injury_severity: ex.injury_severity ?? null,
    injury_multiplier: ex.injury_multiplier ?? null,
    injury_component: ex.injury_component ?? null,
  };
}

/**
 * Twelve teams; first four teams each keep three low-ADP players at equal cost.
 * Budgets net of keeper spend; no single-team monopoly.
 */
function buildKeeperSpreadRealistic(
  pool: LeanPlayer[],
  base: NormalizedValuationInput
): NormalizedValuationInput {
  const sorted = [...pool]
    .filter(
      (p) =>
        p.mlbId != null &&
        Number.isFinite(p.catalog_rank) &&
        p.catalog_rank > 0 &&
        p.catalog_rank < 9999
    )
    .sort((a, b) => a.catalog_rank - b.catalog_rank);
  const teams = ["team_1", "team_2", "team_3", "team_4"] as const;
  const perTeam = 3;
  const keeperCost = 10;
  const pre: Record<string, Array<Record<string, unknown>>> = {};
  for (const t of teams) pre[t] = [];
  for (let i = 0; i < teams.length * perTeam; i++) {
    const teamIdx = Math.floor(i / perTeam);
    const tid = teams[teamIdx]!;
    const p = sorted[i]!;
    pre[tid]!.push({
      player_id: String(p.mlbId),
      name: p.name,
      position: p.position,
      team: p.team ?? "",
      team_id: tid,
      paid: keeperCost,
      is_keeper: true,
      keeper_cost: keeperCost,
    });
  }
  const budget_by_team_id: Record<string, number> = {};
  for (let ti = 1; ti <= base.num_teams; ti++) {
    const id = `team_${ti}`;
    budget_by_team_id[id] = ti <= 4 ? 260 - perTeam * keeperCost : 260;
  }
  return {
    ...base,
    pre_draft_rosters: pre,
    budget_by_team_id,
    user_team_id: "team_1",
  };
}

function sumAuction(rows: ValuedPlayer[]): number {
  return rows.reduce((s, r) => s + (r.auction_value ?? 0), 0);
}

function sumTopN(rows: ValuedPlayer[], n: number): number {
  const sorted = [...rows].sort((a, b) => b.auction_value - a.auction_value);
  return sorted.slice(0, Math.max(0, n)).reduce((s, r) => s + r.auction_value, 0);
}

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
  byId: Map<string, LeanPlayer>,
  ov: ReturnType<typeof positionOverridesFromRequest> | undefined
): "hitter" | "pitcher" {
  const lp = byId.get(row.player_id);
  if (lp) return isPitcherForBaseline(lp, ov ?? undefined) ? "pitcher" : "hitter";
  const pos = (row.position ?? "").toUpperCase();
  if (pos.includes("SP") || pos.includes("RP") || pos === "P") return "pitcher";
  return "hitter";
}

function ge(rows: ValuedPlayer[], t: number): number {
  return rows.filter((r) => r.auction_value >= t).length;
}

function metricsForScenario(
  id: string,
  description: string,
  pool: LeanPlayer[],
  input: NormalizedValuationInput,
  res: { ok: true; response: ValuationResponse } | { ok: false; issues: string[] }
): Record<string, unknown> {
  if (!res.ok) {
    return { id, description, ok: false, issues: res.issues };
  }
  const { response } = res;
  const rows = response.valuations;
  const filteredPool = filterValuationUniverse(pool, {
    leagueScope: input.league_scope,
    eligiblePlayerIds: input.eligible_player_ids,
    excludedPlayerIds: input.excluded_player_ids,
  });
  const byId = poolById(pool);
  const ov = positionOverridesFromRequest(input.position_overrides);
  const leagueBudget = input.total_budget * input.num_teams;
  const dps = response.draftable_pool_size ?? 0;
  const sumTop = dps > 0 ? sumTopN(rows, dps) : null;
  const ratioTop = sumTop != null && leagueBudget > 0 ? sumTop / leagueBudget : null;
  const rem = response.remaining_slots ?? computeRemainingLeagueRosterSlots(
    input.roster_slots,
    input.num_teams,
    input.drafted_players,
    []
  );
  let hit = 0;
  let pit = 0;
  for (const r of rows) {
    if (classifyRow(r, byId, ov) === "hitter") hit += r.auction_value;
    else pit += r.auction_value;
  }
  const hp = hit + pit;
  const sorted = [...rows].sort((a, b) => b.auction_value - a.auction_value);
  const hitRows = rows.filter((r) => classifyRow(r, byId, ov) === "hitter");
  const pitRows = rows.filter((r) => classifyRow(r, byId, ov) === "pitcher");
  const top25 = sorted.slice(0, 25).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    auction_value: r.auction_value,
  }));
  const top15h = [...hitRows].sort((a, b) => b.auction_value - a.auction_value).slice(0, 15).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    auction_value: r.auction_value,
  }));
  const top15p = [...pitRows].sort((a, b) => b.auction_value - a.auction_value).slice(0, 15).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    auction_value: r.auction_value,
  }));
  const byPos = new Map<string, ValuedPlayer>();
  for (const r of rows) {
    const k = (r.position ?? "UNK").toUpperCase();
    const cur = byPos.get(k);
    if (!cur || r.auction_value > cur.auction_value) byPos.set(k, r);
  }
  const topByPosition = Object.fromEntries(
    [...byPos.entries()].map(([k, r]) => [
      k,
      { player_id: r.player_id, name: r.name, auction_value: r.auction_value },
    ])
  );
  const pitcherHarness = buildPitcherHarnessSplits(rows, byId, ov);
  return {
    id,
    description,
    ok: true,
    eligiblePoolSize: filteredPool.length,
    valuationRowCount: rows.length,
    remainingSlots: rem,
    draftablePoolSize: dps,
    poolToSlotRatio: rem > 0 ? filteredPool.length / rem : null,
    leagueBudget,
    sumTopDraftableAuction: sumTop,
    budgetRatioTopDraftable: ratioTop,
    sumAllAuction: sumAuction(rows),
    ratioSumAllToBudget: leagueBudget > 0 ? sumAuction(rows) / leagueBudget : null,
    counts: {
      ge50: ge(rows, 50),
      ge40: ge(rows, 40),
      ge30: ge(rows, 30),
      ge20: ge(rows, 20),
      near1: rows.filter((r) => r.auction_value <= 1.05).length,
    },
    hitterPitcherSplit: hp > 0 ? { hitterShare: hit / hp, pitcherShare: pit / hp } : null,
    scoring_category_warnings: response.scoring_category_warnings ?? null,
    valuation_context: response.valuation_context ?? null,
    valuation_context_warnings: response.valuation_context_warnings ?? null,
    scoring_categories_summary: input.scoring_categories
      .map((c) => `${c.name}:${c.type}`)
      .join("|"),
    validation: { market_notes: response.market_notes ?? [] },
    replacement_values_by_slot_or_position: response.replacement_values_by_slot_or_position ?? null,
    top25,
    top15Hitters: top15h,
    top15Pitchers: top15p,
    topByPosition,
    pitcherHarness,
  };
}

function runTrustEngineReport(
  pool: LeanPlayer[],
  buildInput: () => NormalizedValuationInput
): Record<string, unknown> {
  const b = buildInput();
  const omitExplain = executeValuationWorkflow(pool, b, {}, { debugSignals: false });
  const withExplain = executeValuationWorkflow(
    pool,
    { ...b, explain_valuation_rows: true },
    {},
    { debugSignals: false }
  );
  const thinIds = pool
    .filter((p) => p.mlbId != null)
    .slice(0, 6)
    .map((p) => String(p.mlbId));
  const thinPool = executeValuationWorkflow(
    pool,
    { ...b, eligible_player_ids: thinIds },
    {},
    { debugSignals: false }
  );
  const keeperSkew = executeValuationWorkflow(
    pool,
    {
      ...b,
      drafted_players: [],
      pre_draft_rosters: {
        team_1: Array.from({ length: 12 }, (_, i) => ({
          player_id: `walkthrough_keeper_${i}`,
          name: `Keeper ${i}`,
          position: "OF",
          team: "NYY",
          team_id: "team_1",
        })),
      },
    },
    {},
    { debugSignals: false }
  );
  const uncapped = executeValuationWorkflow(pool, b, {}, { debugSignals: false });
  const capped = executeValuationWorkflow(
    pool,
    { ...b, recommended_bid_soft_cap_ratio: 1.06 },
    {},
    { debugSignals: false }
  );

  const firstRow = omitExplain.ok ? omitExplain.response.valuations[0] : undefined;
  const explainOmittedClean =
    omitExplain.ok &&
    firstRow != null &&
    firstRow.valuation_explain === undefined;

  const exRow = withExplain.ok
    ? withExplain.response.valuations.find((v) => v.valuation_explain != null)
    : undefined;
  const explainKeys =
    exRow?.valuation_explain != null
      ? {
          has_effective_positions:
            (exRow.valuation_explain.effective_positions?.length ?? 0) > 0,
          replacement_key_used: exRow.valuation_explain.replacement_key_used,
          replacement_value_used: exRow.valuation_explain.replacement_value_used,
          has_surplus_basis: exRow.valuation_explain.surplus_basis != null,
          inflation_factor: exRow.valuation_explain.inflation_factor,
          pool_size: exRow.valuation_explain.pool_size,
          roster_demand_slots: exRow.valuation_explain.roster_demand_slots,
          pool_to_slot_ratio: exRow.valuation_explain.pool_to_slot_ratio,
        }
      : null;

  let soft: Record<string, unknown> | null = null;
  if (uncapped.ok && capped.ok && uncapped.response.valuations.length > 0) {
    const pick = [...uncapped.response.valuations].sort(
      (a, c) => c.auction_value - a.auction_value
    )[0];
    if (pick) {
      const cappedRow = capped.response.valuations.find(
        (v) => v.player_id === pick.player_id
      );
      if (cappedRow) {
        soft = {
          player_id: pick.player_id,
          auction_value_uncapped: pick.auction_value,
          auction_value_capped: cappedRow.auction_value,
          recommended_bid_uncapped: pick.recommended_bid,
          recommended_bid_capped: cappedRow.recommended_bid,
          edge_uncapped: pick.edge,
          edge_capped: cappedRow.edge,
        };
      }
    }
  }

  return {
    explain_omitted_no_row_bloat: explainOmittedClean,
    explain_omitted_first_player_id: firstRow?.player_id ?? null,
    with_explain_valuation_rows: {
      ok: withExplain.ok,
      valuation_context: withExplain.ok ? withExplain.response.valuation_context : null,
      valuation_context_warnings:
        withExplain.ok ? withExplain.response.valuation_context_warnings ?? null : null,
      sample_player_id: exRow?.player_id ?? null,
      sample_name: exRow?.name ?? null,
      valuation_explain_keys: explainKeys,
      full_sample_valuation_explain: exRow?.valuation_explain ?? null,
    },
    thin_custom_eligible_six_ids: {
      ok: thinPool.ok,
      valuation_context_warnings:
        thinPool.ok ? thinPool.response.valuation_context_warnings ?? null : null,
      valuation_context: thinPool.ok ? thinPool.response.valuation_context : null,
    },
    keeper_skew_pre_draft: {
      ok: keeperSkew.ok,
      valuation_context_warnings:
        keeperSkew.ok ? keeperSkew.response.valuation_context_warnings ?? null : null,
    },
    recommended_bid_soft_cap_1_06: soft,
    notes: {
      auction_value_unchanged_by_soft_cap:
        soft != null &&
        (soft.auction_value_uncapped as number) === (soft.auction_value_capped as number),
    },
  };
}

function traceRow(r: ValuedPlayer): Record<string, unknown> {
  return {
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    baseline_value: r.baseline_value,
    inflation_factor: r.inflation_factor,
    auction_value: r.auction_value,
    adjusted_value: r.adjusted_value,
    recommended_bid: r.recommended_bid ?? null,
    team_adjusted_value: r.team_adjusted_value ?? null,
    edge: r.edge ?? null,
    replacement_key_used: r.debug_v2?.replacement_key_used ?? null,
    replacement_value_used: r.debug_v2?.replacement_value_used ?? null,
    surplus_basis: r.debug_v2?.surplus_basis ?? null,
    lambda_used: r.debug_v2?.lambda_used ?? null,
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

  const b = () => buildDraftroomStandardValuationInput();

  const noCiMi = draftroomUiDefaultRoster().filter(
    (s) => s.position !== "MI" && s.position !== "CI"
  );
  const fiveOf = draftroomUiDefaultRoster().map((s) =>
    s.position === "OF" ? { ...s, count: 5 } : s
  );

  /** Roster: only generic P (no separate SP/RP rows) — 6 P, trim BN to keep similar total slots */
  const genericPOnly: NormalizedValuationInput["roster_slots"] = [
    { position: "C", count: 1 },
    { position: "1B", count: 1 },
    { position: "2B", count: 1 },
    { position: "SS", count: 1 },
    { position: "3B", count: 1 },
    { position: "MI", count: 1 },
    { position: "CI", count: 1 },
    { position: "OF", count: 3 },
    { position: "UTIL", count: 1 },
    { position: "P", count: 6 },
    { position: "BN", count: 3 },
  ];

  const standardWf0 = executeValuationWorkflow(pool, b(), {}, { debugSignals: true });
  const eliteIds =
    standardWf0.ok
      ? [...standardWf0.response.valuations]
          .sort((a, c) => c.auction_value - a.auction_value)
          .slice(0, 8)
          .map((r) => r.player_id)
      : [];

  const injuryAnchorId =
    ["665742", "660271", "592450"].find(
      (id) => pool.some((p) => p.mlbId != null && String(p.mlbId) === id)
    ) ?? "";

  const keeperHeavyDrafted = pool.slice(0, 32).map((p) => ({
    player_id: String(p.mlbId ?? p._id),
    name: p.name,
    position: p.position,
    team: p.team,
    team_id: "team_1",
    paid: 3,
    is_keeper: true as const,
    keeper_cost: 22,
  }));

  const scenarios: { id: string; description: string; input: NormalizedValuationInput }[] = [
    { id: "01_standard_12_mixed", description: "12-team Mixed 5x5 Draftroom default", input: b() },
    { id: "02_shallow_10_mixed", description: "10-team shallow mixed", input: { ...b(), num_teams: 10 } },
    { id: "03_deep_15_mixed", description: "15-team deep mixed", input: { ...b(), num_teams: 15 } },
    {
      id: "04_two_catcher",
      description: "2 C slots",
      input: {
        ...b(),
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "C" ? { ...s, count: 2 } : s
        ),
      },
    },
    {
      id: "05_five_outfield",
      description: "5 OF",
      input: { ...b(), roster_slots: fiveOf },
    },
    {
      id: "06_no_ci_mi",
      description: "No CI/MI corner slots",
      input: { ...b(), roster_slots: noCiMi },
    },
    {
      id: "07_generic_p_slots",
      description: "Generic P slots (6 P, no SP/RP rows)",
      input: { ...b(), roster_slots: genericPOnly },
    },
    {
      id: "08_obp_not_avg",
      description: "OBP replaces AVG",
      input: {
        ...b(),
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "AVG" ? { name: "OBP", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "09_saves_only",
      description:
        "Saves-focused pitching categories (SV, ERA, WHIP, K — no W); batting unchanged vs 5x5",
      input: { ...b(), scoring_categories: CALIBRATION_CATS_SAVES_ONLY },
    },
    {
      id: "10_sv_hld_label",
      description: "SV+HLD combined pitching category (saves + holds)",
      input: {
        ...b(),
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "SV" ? { name: "SV+HLD", type: "pitching" as const } : c
        ),
      },
    },
    { id: "11_al_only", description: "AL-only league_scope", input: { ...b(), league_scope: "AL" } },
    { id: "12_nl_only", description: "NL-only league_scope", input: { ...b(), league_scope: "NL" } },
    {
      id: "13_keeper_pathological_stress",
      description:
        "Pathological stress: 36 keepers + spend concentrated on team_1 with collapsed team_1 budget (not a realistic league)",
      input: {
        ...b(),
        user_team_id: "team_1",
        drafted_players: keeperHeavyDrafted,
        budget_by_team_id: { team_1: 120 },
      },
    },
    {
      id: "14_keeper_spread_realistic",
      description:
        "Realistic keeper spread: 3 keepers × 4 teams (low ADP players), budgets net of keeper cost, user_team_id team_1",
      input: buildKeeperSpreadRealistic(pool, b()),
    },
    {
      id: "15_eligible_subset",
      description: "eligible_player_ids ~120 players from catalog head",
      input: {
        ...b(),
        eligible_player_ids: pool
          .filter((p) => p.mlbId != null)
          .slice(0, 120)
          .map((p) => String(p.mlbId)),
      },
    },
    {
      id: "16_excluded_elite",
      description: "Exclude top 6 auction values from standard",
      input: {
        ...b(),
        excluded_player_ids: eliteIds.slice(0, 6),
      },
    },
    {
      id: "17_pitching_qs_replaces_w",
      description: "QS replaces W (5×5 batting unchanged)",
      input: {
        ...b(),
        scoring_categories: CALIBRATION_CATS_QS_REPLACES_W,
      },
    },
    {
      id: "18_explicit_sp_rp_default",
      description:
        "Explicit SP + RP roster rows (Draftroom default 5 SP, 2 RP) — contrast pitcherHarness with 07_generic_p_slots",
      input: { ...b() },
    },
    ...(injuryAnchorId
      ? [
          {
            id: "19_injury_override_anchor",
            description: `injury_overrides severity=3 on anchor player_id=${injuryAnchorId} (stable catalog ids used in tests)`,
            input: {
              ...b(),
              injury_overrides: [{ player_id: injuryAnchorId, injury_severity: 3 }],
            },
          },
        ]
      : []),
    {
      id: "20_pitching_hld_addon",
      description: "5×5 + HLD (holds additive pitching category)",
      input: {
        ...b(),
        scoring_categories: [...CALIBRATION_CATS_5X5, { name: "HLD", type: "pitching" as const }],
      },
    },
  ];

  let multiNoOv: NormalizedValuationInput | null = null;
  let multiWithOv: NormalizedValuationInput | null = null;
  if (standardWf0.ok) {
    const hitters = standardWf0.response.valuations
      .filter((r) => {
        const lp = poolById(pool).get(r.player_id);
        return lp && !isPitcherForBaseline(lp, undefined);
      })
      .sort((a, c) => c.auction_value - a.auction_value);
    const mid = hitters[Math.min(40, Math.max(0, hitters.length - 1))]?.player_id;
    const lp = mid ? poolById(pool).get(mid) : undefined;
    if (mid && lp?.mlbId) {
      multiNoOv = { ...b() };
      multiWithOv = {
        ...b(),
        position_overrides: [{ player_id: mid, positions: ["2B", "OF"] }],
      };
    }
  }

  const blocks: Record<string, unknown>[] = [];
  for (const sc of scenarios) {
    const wf = executeValuationWorkflow(pool, sc.input, {}, { debugSignals: true });
    blocks.push(metricsForScenario(sc.id, sc.description, pool, sc.input, wf));
  }

  const extra: Record<string, unknown> = {};
  if (multiNoOv && multiWithOv) {
    const w1 = executeValuationWorkflow(pool, multiNoOv, {}, { debugSignals: true });
    const w2 = executeValuationWorkflow(pool, multiWithOv, {}, { debugSignals: true });
    extra.multi_position = {
      player_id: multiWithOv.position_overrides![0]!.player_id,
      without_override: w1.ok
        ? w1.response.valuations.find(
            (v) => v.player_id === multiWithOv.position_overrides![0]!.player_id
          )
        : null,
      with_override: w2.ok
        ? w2.response.valuations.find(
            (v) => v.player_id === multiWithOv.position_overrides![0]!.player_id
          )
        : null,
    };
  }
  if (standardWf0.ok) {
    const anchorId = [...standardWf0.response.valuations].sort(
      (a, c) => c.auction_value - a.auction_value
    )[5]?.player_id;
    if (anchorId) {
      const wa = executeValuationWorkflow(pool, { ...b(), user_team_id: "team_1" }, {}, { debugSignals: true });
      const wb = executeValuationWorkflow(pool, { ...b(), user_team_id: "team_2" }, {}, { debugSignals: true });
      extra.user_team_compare = {
        player_id: anchorId,
        team_1: wa.ok ? wa.response.valuations.find((v) => v.player_id === anchorId) : null,
        team_2: wb.ok ? wb.response.valuations.find((v) => v.player_id === anchorId) : null,
      };
    }
  }

  const traces: Record<string, unknown>[] = [];
  if (standardWf0.ok) {
    const byId = poolById(pool);
    const ov = positionOverridesFromRequest(undefined);
    const rows = standardWf0.response.valuations;
    const sorted = [...rows].sort((a, c) => c.auction_value - a.auction_value);
    const hitters = sorted.filter((r) => classifyRow(r, byId, ov) === "hitter");
    const pitchers = sorted.filter((r) => classifyRow(r, byId, ov) === "pitcher");
    const cats = hitters.filter((r) => (r.position ?? "").toUpperCase().includes("C"));
    const pick = (arr: ValuedPlayer[], i: number) => arr[Math.min(i, arr.length - 1)];
    const chosen: ValuedPlayer[] = [
      ...hitters.slice(0, 3),
      ...pitchers.slice(0, 3),
      pick(hitters, 15),
      pick(hitters, 25),
      pick(hitters, 35),
      pick(pitchers, 12),
      pick(pitchers, 22),
      pick(pitchers, 35),
      ...cats.slice(0, 3),
    ];
    const uniq = new Map<string, ValuedPlayer>();
    for (const r of chosen) if (r) uniq.set(r.player_id, r);
    for (const r of uniq.values()) traces.push(traceRow(r));
    const strange = sorted.filter((r) => r.auction_value > 45 || (r.baseline_value < 5 && r.auction_value > 15));
    for (const r of strange.slice(0, 4)) {
      if (!uniq.has(r.player_id)) traces.push(traceRow(r));
    }
  }

  const blockById = (id: string) =>
    blocks.find((x) => (x as { id?: string }).id === id) as
      | Record<string, unknown>
      | undefined;

  const stdBlock = blockById("01_standard_12_mixed");
  const savesBlock = blockById("09_saves_only");
  const svHldBlock = blockById("10_sv_hld_label");
  const keeperSpreadBlock = blockById("14_keeper_spread_realistic");

  const rpTop = (block: Record<string, unknown> | undefined): number | null => {
    const tb = block?.topByPosition as
      | Record<string, { auction_value?: number }>
      | undefined;
    const v = tb?.RP?.auction_value;
    return typeof v === "number" ? v : null;
  };

  const pitchShare = (block: Record<string, unknown> | undefined): number | null => {
    const h = block?.hitterPitcherSplit as { pitcherShare?: number } | undefined;
    return typeof h?.pitcherShare === "number" ? h.pitcherShare : null;
  };

  const walkthrough_checks: Record<string, unknown> = {
    saves_only_scoring_categories_differ_from_standard: (() => {
      const a = stdBlock?.scoring_categories_summary;
      const b = savesBlock?.scoring_categories_summary;
      return typeof a === "string" && typeof b === "string" && a !== b;
    })(),
    saves_only_pitching_differs_from_standard: (() => {
      const p0 = pitchShare(stdBlock);
      const p1 = pitchShare(savesBlock);
      const r0 = rpTop(stdBlock);
      const r1 = rpTop(savesBlock);
      const shareDiff =
        p0 != null && p1 != null && Math.abs(p0 - p1) > 1e-5;
      const rpDiff =
        r0 != null && r1 != null && Math.abs(r0 - r1) > 0.001;
      return shareDiff || rpDiff;
    })(),
    saves_only_vs_sv_hld_rp_top: (() => ({
      saves_only: rpTop(savesBlock),
      sv_hld_label: rpTop(svHldBlock),
    }))(),
    keeper_spread_realistic: keeperSpreadBlock
      ? {
          ok: keeperSpreadBlock.ok === true,
          valuation_context_warnings: keeperSpreadBlock.valuation_context_warnings ?? null,
          sum_all_auction_vs_league_budget: keeperSpreadBlock.ratioSumAllToBudget,
          hitter_pitcher_share: keeperSpreadBlock.hitterPitcherSplit,
        }
      : null,
  };

  const sumTop20RpAuction = (block: Record<string, unknown> | undefined): number => {
    const ph = block?.pitcherHarness as { top20RpClosersStyle?: Array<{ auction_value: number }> } | undefined;
    return (ph?.top20RpClosersStyle ?? []).reduce((s, x) => s + x.auction_value, 0);
  };

  const midTierRpSum = (block: Record<string, unknown> | undefined): number | null => {
    const ph = block?.pitcherHarness as { midTierRp_ranks_10_to_19_sum_auction?: number } | undefined;
    return typeof ph?.midTierRp_ranks_10_to_19_sum_auction === "number"
      ? ph.midTierRp_ranks_10_to_19_sum_auction
      : null;
  };

  let injury_override_harness: Record<string, unknown> | null = null;
  if (injuryAnchorId) {
    const baseIn = b();
    const healthy = executeValuationWorkflow(
      pool,
      {
        ...baseIn,
        injury_overrides: [{ player_id: injuryAnchorId, injury_severity: 0 }],
        explain_valuation_rows: true,
      },
      {},
      { debugSignals: true }
    );
    const injured = executeValuationWorkflow(
      pool,
      {
        ...baseIn,
        injury_overrides: [{ player_id: injuryAnchorId, injury_severity: 3 }],
        explain_valuation_rows: true,
      },
      {},
      { debugSignals: true }
    );
    const rowH = healthy.ok ? healthy.response.valuations.find((v) => v.player_id === injuryAnchorId) : undefined;
    const rowI = injured.ok ? injured.response.valuations.find((v) => v.player_id === injuryAnchorId) : undefined;
    injury_override_harness = {
      anchor_player_id: injuryAnchorId,
      healthy_override_severity_0: rowH
        ? {
            baseline_value: rowH.baseline_value,
            auction_value: rowH.auction_value,
            valuation_explain_injury: sliceInjuryExplain(rowH.valuation_explain),
          }
        : null,
      injured_override_severity_3: rowI
        ? {
            baseline_value: rowI.baseline_value,
            auction_value: rowI.auction_value,
            valuation_explain_injury: sliceInjuryExplain(rowI.valuation_explain),
          }
        : null,
      checks: {
        baseline_strictly_lower_when_injured:
          rowH != null && rowI != null ? rowI.baseline_value < rowH.baseline_value : null,
        auction_value_changes_with_injury:
          rowH != null && rowI != null ? rowI.auction_value !== rowH.auction_value : null,
        explain_has_injury_fields_when_injured:
          rowI?.valuation_explain != null &&
          rowI.valuation_explain.injury_severity !== undefined &&
          rowI.valuation_explain.injury_multiplier !== undefined,
      },
    };
  }

  const hldBlock = blockById("20_pitching_hld_addon");
  const qsBlock = blockById("17_pitching_qs_replaces_w");
  const genPBlock = blockById("07_generic_p_slots");
  const spRpBlock = blockById("18_explicit_sp_rp_default");

  const relief_scoring_harness = {
    top20_rp_auction_sum_by_scenario: {
      standard_mixed: sumTop20RpAuction(stdBlock),
      saves_only: sumTop20RpAuction(savesBlock),
      sv_hld_label: sumTop20RpAuction(svHldBlock),
      hld_addon: sumTop20RpAuction(hldBlock),
    },
    mid_tier_rp_sum_ranks_10_to_19: {
      standard_mixed: midTierRpSum(stdBlock),
      saves_only: midTierRpSum(savesBlock),
      sv_hld_label: midTierRpSum(svHldBlock),
      hld_addon: midTierRpSum(hldBlock),
    },
    mid_tier_rp_delta_vs_standard: {
      saves_only_minus_standard:
        midTierRpSum(savesBlock) != null && midTierRpSum(stdBlock) != null
          ? (midTierRpSum(savesBlock) as number) - (midTierRpSum(stdBlock) as number)
          : null,
      sv_hld_label_minus_standard:
        midTierRpSum(svHldBlock) != null && midTierRpSum(stdBlock) != null
          ? (midTierRpSum(svHldBlock) as number) - (midTierRpSum(stdBlock) as number)
          : null,
      hld_addon_minus_standard:
        midTierRpSum(hldBlock) != null && midTierRpSum(stdBlock) != null
          ? (midTierRpSum(hldBlock) as number) - (midTierRpSum(stdBlock) as number)
          : null,
    },
  };

  const roster_slot_compare_harness = {
    note: "Compare explicit SP/RP default (18) vs generic P-only (07): replacement_values_by_slot_or_position and pitcherHarness.",
    generic_p_slots: genPBlock
      ? {
          replacement_values_by_slot_or_position: genPBlock.replacement_values_by_slot_or_position ?? null,
          pitcherHarness: genPBlock.pitcherHarness ?? null,
        }
      : null,
    explicit_sp_rp_default: spRpBlock
      ? {
          replacement_values_by_slot_or_position: spRpBlock.replacement_values_by_slot_or_position ?? null,
          pitcherHarness: spRpBlock.pitcherHarness ?? null,
        }
      : null,
  };

  const qs_scoring_harness = qsBlock
    ? {
        hitter_pitcher_split: qsBlock.hitterPitcherSplit ?? null,
        scoring_category_warnings: qsBlock.scoring_category_warnings ?? null,
        valuation_context_warnings: qsBlock.valuation_context_warnings ?? null,
        top15_pitchers: qsBlock.top15Pitchers ?? null,
        pitcherHarness: qsBlock.pitcherHarness ?? null,
      }
    : null;

  const out = {
    generatedAt: new Date().toISOString(),
    scenarios: blocks,
    extra,
    formulaTracesStandard: traces,
    inflationSummaryStandard: standardWf0.ok
      ? {
          inflation_factor: standardWf0.response.inflation_factor,
          inflation_raw: standardWf0.response.inflation_raw,
          draftable_pool_size: standardWf0.response.draftable_pool_size,
        }
      : null,
    trust_engine_report: runTrustEngineReport(pool, () => buildDraftroomStandardValuationInput()),
    walkthrough_alignment_note:
      "Shallow/deep team counts (10 / 15) match scripts/calibrate-valuations.ts after alignment.",
    coverage_expansion_note:
      "Scenarios 17–20: QS replaces W; explicit SP/RP default (same roster as 01); optional 19 injury_overrides when anchor id exists in catalog; 5×5+HLD. Each scenario includes pitcherHarness (top10 SP/RP, top20 RP-closer focus, mid-tier RP ranks 10–19). injury_override_harness runs severity 0 vs 3 with explain_valuation_rows.",
    walkthrough_checks,
    injury_override_harness,
    relief_scoring_harness,
    roster_slot_compare_harness,
    qs_scoring_harness,
  };

  const abs = path.join(ROOT, "tmp", "real-walkthrough-scenarios.json");
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(out, null, 2));
  console.log("Wrote", abs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
