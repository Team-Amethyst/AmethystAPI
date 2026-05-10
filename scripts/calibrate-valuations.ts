/**
 * Valuation calibration harness: runs real `executeValuationWorkflow` over
 * standard and comparison league fixtures, prints distribution diagnostics,
 * and surfaces unsupported scoring categories (see `scoringCategorySupport.ts`).
 *
 * Usage:
 *   pnpm calibrate-valuations              # synthetic catalog (no Mongo)
 *   pnpm calibrate-valuations -- --mongo   # full Mongo catalog (requires MONGO_URI)
 *   pnpm calibrate-valuations -- --json-out=tmp/calibration-report.json
 *
 * Shallow/deep team counts (10 / 15) align with `scripts/real-world-valuation-walkthrough.ts`.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import type { LeanPlayer, NormalizedValuationInput, ValuationResponse, ValuedPlayer } from "../src/types/brain";
import {
  buildDraftroomStandardValuationInput,
  buildSyntheticCalibrationDraftroomPool,
  CALIBRATION_CATS_5X5,
  CALIBRATION_CATS_SAVES_ONLY,
  draftroomUiDefaultRoster,
  legacyEngineCalibrationRoster,
} from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { ROTO_Z_HITTER, ROTO_Z_PITCHER } from "../src/services/baselineRotoZConfig";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { listUnsupportedScoringCategories } from "../src/lib/scoringCategorySupport";

const ROOT = path.resolve(__dirname, "..");

function baseInput(): NormalizedValuationInput {
  return buildDraftroomStandardValuationInput();
}

function buildSyntheticCalibrationPool(): LeanPlayer[] {
  return buildSyntheticCalibrationDraftroomPool();
}

async function loadMongoCatalog(): Promise<LeanPlayer[]> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI is not set (required for --mongo)");
  }
  await mongoose.connect(uri);
  try {
    return await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
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
  ov?: ReturnType<typeof positionOverridesFromRequest>
): "hitter" | "pitcher" {
  const lp = byId.get(row.player_id);
  if (lp) {
    return isPitcherForBaseline(lp, ov ?? undefined) ? "pitcher" : "hitter";
  }
  const pos = (row.position ?? "").toUpperCase();
  if (pos.includes("SP") || pos.includes("RP") || pos === "P") return "pitcher";
  return "hitter";
}

function sumAuction(rows: ValuedPlayer[]): number {
  return rows.reduce((s, r) => s + (r.auction_value ?? 0), 0);
}

function sumTopN(rows: ValuedPlayer[], n: number): number {
  const sorted = [...rows].sort((a, b) => b.auction_value - a.auction_value);
  return sorted.slice(0, Math.max(0, n)).reduce((s, r) => s + r.auction_value, 0);
}

function topByPosition(rows: ValuedPlayer[]): Map<string, ValuedPlayer> {
  const m = new Map<string, ValuedPlayer>();
  for (const r of rows) {
    const key = (r.position ?? "UNK").toUpperCase();
    const cur = m.get(key);
    if (!cur || r.auction_value > cur.auction_value) m.set(key, r);
  }
  return m;
}

function heuristicFlags(params: {
  leagueBudget: number;
  sumAll: number;
  ratio: number;
  nearOne: number;
  rows: number;
}): string[] {
  const hints: string[] = [];
  if (params.ratio < 0.72 || params.ratio > 1.38) {
    hints.push(
      `Ratio sum(auction_value)/league_budget = ${params.ratio.toFixed(3)} is outside heuristic band [0.72, 1.38] (not a hard failure).`
    );
  }
  const nearFrac = params.rows > 0 ? params.nearOne / params.rows : 0;
  if (nearFrac > 0.55) {
    hints.push(
      `Very large share of players (${(nearFrac * 100).toFixed(0)}%) have auction_value ≤ $1.05 — inflation floor / pool shape may be dominating.`
    );
  }
  if (params.sumAll < params.leagueBudget * 0.35) {
    hints.push(
      "Total auction_value mass is low vs league budget — review replacement_slots_v2 surplus allocation and baseline zScale clamps."
    );
  }
  return hints;
}

function printKnobsReference(): void {
  console.log(`
--- Engine calibration knobs (inspect only) ---
  baselineValueEngine: ROTO_INTRINSIC_BASE_HITTER = 24, ROTO_INTRINSIC_BASE_PITCHER = 20, ROTO_CATALOG_PRIOR_WEIGHT = 0.12
  baselineRotoZConfig.ts (rotoBaselineForGroup z → projectionMult):
    hitter  zScale=${ROTO_Z_HITTER.zScale}  zLo=${ROTO_Z_HITTER.zLo}  zHi=${ROTO_Z_HITTER.zHi}
    pitcher zScale=${ROTO_Z_PITCHER.zScale}  zLo=${ROTO_Z_PITCHER.zLo}  zHi=${ROTO_Z_PITCHER.zHi}
  speculativePriorBaselineFloor() — weak-catalog prior lift for late ADP (baselineValueEngine.ts)
`);
}

type Scenario = {
  id: string;
  description: string;
  input: NormalizedValuationInput;
};

function buildScenarios(): Scenario[] {
  const b = baseInput();
  return [
    {
      id: "standard_12_mixed",
      description:
        "12-team Mixed 5x5, replacement_slots_v2 — Draftroom web/mobile default roster (no P; 2 RP; 3 BN)",
      input: { ...b },
    },
    {
      id: "legacy_engine_calibration_roster",
      description:
        "Same as standard but legacy harness roster: generic P, 3 RP, 7 BN (old API/Mongo-style calibration shape)",
      input: { ...b, roster_slots: legacyEngineCalibrationRoster() },
    },
    {
      id: "batting_obp",
      description: "OBP replaces AVG (same 5x5 pitching)",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "AVG" ? { name: "OBP", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "pitching_sv_hld_label",
      description: "SV+HLD combined label (unsupported vs separate SV+HLD stats)",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "SV" ? { name: "SV+HLD", type: "pitching" as const } : c
        ),
      },
    },
    {
      id: "pitching_saves_only",
      description:
        "Saves-focused pitching categories (SV, ERA, WHIP, K — no W); batting unchanged — compare to standard_12_mixed",
      input: { ...b, scoring_categories: CALIBRATION_CATS_SAVES_ONLY },
    },
    {
      id: "catcher_2c",
      description:
        "2 C slots (same universe as standard_12_mixed — JSON report `catcher_comparison` pairs top C vs standard_12_mixed)",
      input: {
        ...b,
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "C" ? { ...s, count: 2 } : s
        ),
      },
    },
    {
      id: "league_al_only",
      description: "AL-only scope (same roster)",
      input: { ...b, league_scope: "AL" },
    },
    {
      id: "league_nl_only",
      description: "NL-only scope",
      input: { ...b, league_scope: "NL" },
    },
    {
      id: "shallow_10",
      description: "Shallow: 10 teams (aligned with valuation-walkthrough shallow mixed)",
      input: { ...b, num_teams: 10 },
    },
    {
      id: "deep_15",
      description: "Deep: 15 teams (aligned with valuation-walkthrough deep mixed)",
      input: { ...b, num_teams: 15 },
    },
    {
      id: "multi_pos_override",
      description: "Multi-position override 777001 → [2B, OF] (synthetic pool only)",
      input: {
        ...b,
        position_overrides: [{ player_id: "777001", positions: ["2B", "OF"] }],
      },
    },
    {
      id: "multi_pos_baseline",
      description: "Same as standard (777001 remains OF-only in synthetic pool)",
      input: { ...b },
    },
    {
      id: "unsupported_hld_addon",
      description: "Adds HLD (unsupported) alongside modeled categories — expect warnings",
      input: {
        ...b,
        scoring_categories: [...CALIBRATION_CATS_5X5, { name: "HLD", type: "pitching" }],
      },
    },
  ];
}

function printScenarioReport(
  scenario: Scenario,
  res: { ok: true; response: ValuationResponse } | { ok: false; issues: string[] },
  pool: LeanPlayer[],
  synthetic: boolean
): Record<string, unknown> {
  console.log(`\n${"=".repeat(72)}\nSCENARIO: ${scenario.id}\n${scenario.description}\n${"=".repeat(72)}`);
  if (!res.ok) {
    console.log("WORKFLOW FAILED:", res.issues.join("; "));
    return { scenario: scenario.id, ok: false, issues: res.issues };
  }
  const { response } = res;
  const rows = response.valuations;
  const byId = poolById(pool);
  const ov = positionOverridesFromRequest(scenario.input.position_overrides);
  const leagueBudget = scenario.input.total_budget * scenario.input.num_teams;
  const sumAll = sumAuction(rows);
  const ratio = leagueBudget > 0 ? sumAll / leagueBudget : 0;
  const dps = response.draftable_pool_size;
  const sumDraftableTop =
    dps != null && dps > 0 ? sumTopN(rows, dps) : null;
  const ratioDraftable =
    sumDraftableTop != null && leagueBudget > 0 ? sumDraftableTop / leagueBudget : null;

  const ge = (t: number) => rows.filter((r) => r.auction_value >= t).length;
  const nearOne = rows.filter((r) => r.auction_value <= 1.05).length;

  let hitSum = 0;
  let pitSum = 0;
  for (const r of rows) {
    const side = classifyRow(r, byId, ov);
    if (side === "hitter") hitSum += r.auction_value;
    else pitSum += r.auction_value;
  }
  const hp = hitSum + pitSum;

  console.log(`Pool rows (post-filter): ${pool.length} → valuation rows: ${rows.length}`);
  console.log(`League budget (num_teams × total_budget): ${leagueBudget}`);
  console.log(`Sum auction_value (all rows): ${sumAll.toFixed(2)}  ratio: ${ratio.toFixed(4)}`);
  if (sumDraftableTop != null) {
    console.log(
      `Sum top-${dps} auction_value (draftable_pool_size slice): ${sumDraftableTop.toFixed(2)}` +
        (ratioDraftable != null ? `  ratio: ${ratioDraftable.toFixed(4)}` : "")
    );
  }
  if (response.remaining_slots != null) {
    console.log(`remaining_slots (v2): ${response.remaining_slots}`);
  }
  if (response.draftable_pool_size != null) {
    console.log(`draftable_pool_size: ${response.draftable_pool_size}`);
  }
  if (response.scoring_category_warnings?.length) {
    console.log("scoring_category_warnings:");
    for (const w of response.scoring_category_warnings) console.log(`  - ${w}`);
  }
  const uns = listUnsupportedScoringCategories(scenario.input.scoring_categories);
  if (uns.length && !response.scoring_category_warnings?.length) {
    console.log(
      "NOTE: categories flagged as unsupported by analyzer but no response warnings (strict path or workflow bug)."
    );
  }

  console.log("\nCounts auction_value thresholds:");
  console.log(`  >=50: ${ge(50)}  >=40: ${ge(40)}  >=30: ${ge(30)}  >=20: ${ge(20)}  >=10: ${ge(10)}`);
  console.log(`  <=1.05 (near min): ${nearOne}`);

  console.log(
    `\nDollar share (hitter / pitcher): ${hp > 0 ? ((hitSum / hp) * 100).toFixed(1) : "n/a"}% / ${hp > 0 ? ((pitSum / hp) * 100).toFixed(1) : "n/a"}%`
  );

  const top50 = [...rows].sort((a, b) => b.auction_value - a.auction_value).slice(0, 50);
  const hitRows = rows.filter((r) => classifyRow(r, byId, ov) === "hitter");
  const pitRows = rows.filter((r) => classifyRow(r, byId, ov) === "pitcher");
  const top25h = [...hitRows].sort((a, b) => b.auction_value - a.auction_value).slice(0, 25);
  const top25p = [...pitRows].sort((a, b) => b.auction_value - a.auction_value).slice(0, 25);

  console.log("\nTop 10 overall (player_id, position, auction_value):");
  for (const r of top50.slice(0, 10)) {
    console.log(`  ${r.player_id}\t${r.position}\t$${r.auction_value.toFixed(2)}`);
  }
  console.log("\nTop 5 hitters:");
  for (const r of top25h.slice(0, 5)) {
    console.log(`  ${r.player_id}\t${r.position}\t$${r.auction_value.toFixed(2)}`);
  }
  console.log("\nTop 5 pitchers:");
  for (const r of top25p.slice(0, 5)) {
    console.log(`  ${r.player_id}\t${r.position}\t$${r.auction_value.toFixed(2)}`);
  }

  const byPos = topByPosition(rows);
  console.log("\nHigh auction_value by primary position (sample):");
  const keys = [...byPos.keys()].sort();
  for (const k of keys.slice(0, 14)) {
    const r = byPos.get(k)!;
    console.log(`  ${k}: ${r.player_id} $${r.auction_value.toFixed(2)}`);
  }

  if (response.replacement_values_by_slot_or_position) {
    console.log("\nreplacement_values_by_slot_or_position:");
    for (const [k, v] of Object.entries(response.replacement_values_by_slot_or_position)) {
      console.log(`  ${k}: ${typeof v === "number" ? v.toFixed(2) : v}`);
    }
  }

  const hints = heuristicFlags({
    leagueBudget,
    sumAll,
    ratio,
    nearOne,
    rows: rows.length,
  });
  if (hints.length) {
    console.log("\nHeuristic realism flags:");
    for (const h of hints) console.log(`  * ${h}`);
  }

  if (scenario.id.startsWith("multi_pos") && synthetic) {
    const row = rows.find((r) => r.player_id === "777001");
    if (row) {
      console.log(`\n777001 auction_value: $${row.auction_value.toFixed(2)}`);
    }
  }

  return {
    scenario: scenario.id,
    ok: true,
    poolRows: pool.length,
    valuationRows: rows.length,
    leagueBudget,
    sumAuctionAll: sumAll,
    ratioSumToBudget: ratio,
    sumTopDraftablePoolSize: sumDraftableTop,
    ratioTopDraftableToBudget: ratioDraftable,
    remaining_slots: response.remaining_slots,
    draftable_pool_size: response.draftable_pool_size,
    valuation_context: response.valuation_context ?? null,
    valuation_context_warnings: response.valuation_context_warnings ?? null,
    scoring_categories_summary: scenario.input.scoring_categories
      .map((c) => `${c.name}:${c.type}`)
      .join("|"),
    counts: { ge50: ge(50), ge40: ge(40), ge30: ge(30), ge20: ge(20), ge10: ge(10), nearOne },
    hitterShare: hp > 0 ? hitSum / hp : null,
    pitcherShare: hp > 0 ? pitSum / hp : null,
    top50: top50.map((r) => ({
      player_id: r.player_id,
      position: r.position,
      auction_value: r.auction_value,
    })),
    top25Hitters: top25h.map((r) => ({
      player_id: r.player_id,
      position: r.position,
      auction_value: r.auction_value,
    })),
    top25Pitchers: top25p.map((r) => ({
      player_id: r.player_id,
      position: r.position,
      auction_value: r.auction_value,
    })),
    topByPosition: Object.fromEntries(
      [...byPos.entries()].map(([k, r]) => [k, { player_id: r.player_id, auction_value: r.auction_value }])
    ),
    replacement_values: response.replacement_values_by_slot_or_position ?? null,
    scoring_category_warnings: response.scoring_category_warnings ?? null,
    heuristicFlags: hints,
  };
}

function parseArgs(argv: string[]): { mongo: boolean; jsonOut: string | null } {
  let mongo = false;
  let jsonOut: string | null = null;
  for (const a of argv) {
    if (a === "--mongo") mongo = true;
    if (a.startsWith("--json-out=")) jsonOut = a.slice("--json-out=".length) || null;
  }
  return { mongo, jsonOut };
}

async function main(): Promise<void> {
  const { mongo, jsonOut } = parseArgs(process.argv.slice(2));
  console.log("=== Amethyst valuation calibration ===");
  console.log(`Root: ${ROOT}`);
  console.log(`Catalog: ${mongo ? "Mongo (MONGO_URI)" : "synthetic (~620 players with projections)"}`);

  const pool = mongo ? await loadMongoCatalog() : buildSyntheticCalibrationPool();
  printKnobsReference();

  const scenarios = buildScenarios().filter((s) => {
    if (s.id.startsWith("multi_pos") && mongo) {
      return false;
    }
    return true;
  });

  const report: Record<string, unknown>[] = [];
  for (const sc of scenarios) {
    const wf = executeValuationWorkflow(pool, sc.input);
    const block = printScenarioReport(sc, wf, pool, !mongo);
    report.push(block);
  }

  console.log(`\n${"#".repeat(72)}\nUnsupported category probe (analyzer)`);
  const probeNames = ["HLD", "SV+HLD", "QS", "OBP", "SLG", "OPS", "K/9", "TB"];
  for (const name of probeNames) {
    const t =
      name === "OBP" || name === "SLG" || name === "OPS" || name === "TB"
        ? ("batting" as const)
        : ("pitching" as const);
    const u = listUnsupportedScoringCategories([{ name, type: t }]);
    console.log(
      `  ${name} (${t}): ${u.length === 0 ? "SUPPORTED" : "unsupported — " + u.map((x) => x.normalized).join(",")}`
    );
  }

  console.log(`\n${"#".repeat(72)}\nRecommended tuning order (after reports; no constants changed here)`);
  console.log("  1. If ratio sum/budget is wild: replacement_slots_v2 surplus cash vs mass, inflation cap/floor in workflow retry.");
  console.log("  2. If hit/pitch dollar share looks off: roto group zScale / zLo-zHi clamps (baselineValueEngine rotoBaselineForGroup).");
  console.log("  3. If stars too flat vs scrubs: ROTO_CATALOG_PRIOR_WEIGHT vs intrinsic bases.");
  console.log("  4. If list tail is wrong: speculativePriorBaselineFloor thresholds.");
  console.log("  5. Wire unsupported categories (statFieldForCategory + categoryRawValue) before retuning weights for those stats.");

  if (jsonOut) {
    const abs = path.isAbsolute(jsonOut) ? jsonOut : path.join(ROOT, jsonOut);
    const dir = path.dirname(abs);
    mkdirSync(dir, { recursive: true });
    const c1 = report.find(
      (r) => typeof r === "object" && r !== null && (r as { scenario?: string }).scenario === "standard_12_mixed"
    ) as { topByPosition?: Record<string, { player_id?: string; auction_value?: number }> } | undefined;
    const c2 = report.find(
      (r) => typeof r === "object" && r !== null && (r as { scenario?: string }).scenario === "catcher_2c"
    ) as { topByPosition?: Record<string, { player_id?: string; auction_value?: number }> } | undefined;
    const catcher_comparison =
      c1?.topByPosition?.C != null && c2?.topByPosition?.C != null
        ? {
            note: "1C baseline is standard_12_mixed (Draftroom default 1× C); 2C is catcher_2c.",
            top_catcher_1c_standard: c1.topByPosition.C,
            top_catcher_2c: c2.topByPosition.C,
          }
        : null;
    const stdPitch = report.find(
      (r) => typeof r === "object" && r !== null && (r as { scenario?: string }).scenario === "standard_12_mixed"
    ) as {
      scoring_categories_summary?: string;
      pitcherShare?: number | null;
      topByPosition?: Record<string, { auction_value?: number }>;
    } | undefined;
    const savesPitch = report.find(
      (r) => typeof r === "object" && r !== null && (r as { scenario?: string }).scenario === "pitching_saves_only"
    ) as {
      scoring_categories_summary?: string;
      pitcherShare?: number | null;
      topByPosition?: Record<string, { auction_value?: number }>;
    } | undefined;
    const topRpAuction = (
      block: { topByPosition?: Record<string, { auction_value?: number }> } | undefined
    ): number | null => {
      const v = block?.topByPosition?.RP?.auction_value;
      return typeof v === "number" ? v : null;
    };
    const rpStd = topRpAuction(stdPitch);
    const rpSaves = topRpAuction(savesPitch);
    const shareDiff =
      typeof stdPitch?.pitcherShare === "number" &&
      typeof savesPitch?.pitcherShare === "number" &&
      Math.abs(stdPitch.pitcherShare - savesPitch.pitcherShare) > 1e-5;
    const rpDiff =
      rpStd != null && rpSaves != null && Math.abs(rpStd - rpSaves) > 0.001;
    const calibration_checks = {
      saves_only_scoring_categories_differ_from_standard:
        stdPitch?.scoring_categories_summary != null &&
        savesPitch?.scoring_categories_summary != null &&
        stdPitch.scoring_categories_summary !== savesPitch.scoring_categories_summary,
      saves_only_pitcher_share_differs_from_standard: shareDiff,
      saves_only_top_rp_differs_from_standard: rpDiff,
      saves_only_pitching_distribution_differs_from_standard: shareDiff || rpDiff,
      saves_only_top_rp_pair: { standard: rpStd, saves_only: rpSaves },
    };
    writeFileSync(
      abs,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          calibration_alignment_note:
            "shallow_10 / deep_15 match scripts/real-world-valuation-walkthrough.ts (10- and 15-team). Legacy ids shallow_8 / deep_16 / catcher_1v2 removed; 1C vs 2C uses standard_12_mixed + catcher_2c (see catcher_comparison).",
          catcher_comparison,
          calibration_checks,
          scenarios: report,
        },
        null,
        2
      )
    );
    console.log(`\nWrote JSON report: ${abs}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
