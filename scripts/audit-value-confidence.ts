/**
 * `pnpm audit:value-confidence` — multi-scenario valuation quality harness (read-only catalog).
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";
import type { ValuationResponse, ValuedPlayer } from "../src/types/valuation";
import { buildSyntheticCalibrationDraftroomPool } from "../src/lib/calibrationDraftroomFixture";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { isValuationEligibleCatalogRow } from "../src/lib/catalogRowClassification";
import { sumAuctionValueForDraftablePool } from "../src/lib/rosterUniverseValuationCalibration";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { buildValueConfidenceScenarios } from "../src/lib/valueConfidence/scenarios";
import {
  buildHeadlinePlayerChecks,
  collectSuspiciousValueFindings,
  findDuplicateMlbIds,
  nearOneDollarDraftableSplit,
  summarizeFindings,
  topPitcherAuctions,
  type HeadlinePlayerCheck,
  type SuspiciousValueFinding,
} from "../src/lib/valueConfidence/classifier";

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_JSON = path.join(ROOT, "tmp/value-confidence-report.json");
const REFERENCE_SCENARIO_ID = "vc_Mixed_t12_avg_clean";

function poolById(pool: LeanPlayer[]): Map<string, LeanPlayer> {
  const m = new Map<string, LeanPlayer>();
  for (const p of pool) {
    const id = p.mlbId != null ? String(p.mlbId) : String(p._id);
    m.set(id, p);
  }
  return m;
}

function rowIsPitcher(
  row: ValuedPlayer,
  byId: Map<string, LeanPlayer>,
  ov: ReturnType<typeof positionOverridesFromRequest>
): boolean {
  const sel = row.baseline_components?.two_way_role_selected;
  if (sel === "pitcher") return true;
  if (sel === "hitter") return false;
  const lp = byId.get(row.player_id);
  if (lp) return isPitcherForBaseline(lp, ov);
  const pos = (row.position ?? "").toUpperCase();
  return pos.includes("SP") || pos.includes("RP") || pos === "P";
}

function scenarioSnapshot(params: {
  scenarioId: string;
  input: NormalizedValuationInput;
  response: ValuationResponse;
  pool: LeanPlayer[];
}): Record<string, unknown> {
  const { scenarioId, input, response, pool } = params;
  const rows = response.valuations;
  const byId = poolById(pool);
  const ov = positionOverridesFromRequest(input.position_overrides);
  let hit$ = 0;
  let pit$ = 0;
  for (const r of rows) {
    if (rowIsPitcher(r, byId, ov)) pit$ += r.auction_value;
    else hit$ += r.auction_value;
  }
  const hp = hit$ + pit$;
  const sorted = [...rows].sort((a, b) => b.auction_value - a.auction_value);
  const top25 = sorted.slice(0, 25).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    auction_value: r.auction_value,
    market_adp: r.market_adp ?? null,
  }));
  const catchers = sorted.filter((r) => (r.position ?? "").toUpperCase().trim() === "C");
  const topCatchers = catchers.slice(0, 8).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    auction_value: r.auction_value,
  }));
  const spRows = sorted.filter((r) => (r.position ?? "").toUpperCase().includes("SP"));
  const rpRows = sorted.filter((r) => {
    const p = (r.position ?? "").toUpperCase();
    return p.includes("RP") || p === "P";
  });
  const topSp = spRows.slice(0, 8).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    auction_value: r.auction_value,
  }));
  const topRp = rpRows.slice(0, 8).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    auction_value: r.auction_value,
  }));
  const leagueBudget = input.total_budget * input.num_teams;
  const { sum: draftableSum } = sumAuctionValueForDraftablePool(rows, response);
  const ratioDraftable =
    leagueBudget > 0 ? draftableSum / leagueBudget : null;
  const near = nearOneDollarDraftableSplit(rows, response);
  const warnings: string[] = [
    ...(response.scoring_category_warnings ?? []),
    ...(response.valuation_context_warnings ?? []),
  ];
  if (response.inflation_bounded_by === "cap" && ratioDraftable != null && ratioDraftable < 0.97) {
    warnings.push(
      "inflation_cap_binding: draftable auction mass below league budget — see inflation_raw vs inflation_factor in response."
    );
  }
  return {
    scenario_id: scenarioId,
    ok: true,
    pool_size: pool.length,
    valuation_eligible_in_pool: pool.filter((p) => isValuationEligibleCatalogRow(p)).length,
    valuation_rows: rows.length,
    draftable_pool_size: response.draftable_pool_size ?? null,
    remaining_slots: response.remaining_slots ?? null,
    top_25_auction_values: top25,
    hitter_pitcher_split: hp > 0 ? { hitter_share: hit$ / hp, pitcher_share: pit$ / hp } : null,
    top_catchers: topCatchers,
    top_sp: topSp,
    top_rp: topRp,
    near_one_dollar: {
      le_105_draftable: near.nearOneDraftable,
      le_105_outside_draftable: near.nearOneOutside,
      le_105_unknown: near.nearOneUnknown,
    },
    budget_ratio_draftable_player_ids: ratioDraftable,
    inflation_raw: response.inflation_raw,
    inflation_factor: response.inflation_factor,
    inflation_bounded_by: response.inflation_bounded_by,
    warnings,
  };
}

async function loadPool(mongo: boolean): Promise<LeanPlayer[]> {
  if (!mongo) return buildSyntheticCalibrationDraftroomPool();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set (required for --mongo)");
  await mongoose.connect(uri, scriptMongoConnectOptions());
  try {
    return await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

function parseArgs(argv: string[]): { mongo: boolean; jsonOut: string } {
  let mongo = false;
  let jsonOut = DEFAULT_JSON;
  for (const a of argv) {
    if (a === "--mongo") mongo = true;
    if (a.startsWith("--json-out=")) jsonOut = a.slice("--json-out=".length) || DEFAULT_JSON;
  }
  const abs = path.isAbsolute(jsonOut) ? jsonOut : path.join(ROOT, jsonOut);
  return { mongo, jsonOut: abs };
}

async function main(): Promise<void> {
  const { mongo, jsonOut } = parseArgs(process.argv.slice(2));
  console.log("=== audit:value-confidence ===");
  console.log(`Catalog: ${mongo ? "Mongo (MONGO_URI)" : "synthetic calibration pool"}`);

  const pool = await loadPool(mongo);
  const scenarios = buildValueConfidenceScenarios(pool);
  const dupMlb = findDuplicateMlbIds(pool);
  const globalFindings: SuspiciousValueFinding[] = [];
  if (dupMlb.length > 0) {
    for (const d of dupMlb) {
      globalFindings.push({
        scenario_id: "__global__",
        rule_id: "duplicate_mlb_id_in_pool",
        severity: "important",
        classification: "sync/catalog issue",
        player_id: "__catalog__",
        name: `mlbId ${d.mlbId} ×${d.count}`,
        market_adp: null,
        auction_rank: null,
        auction_value: null,
        team_value: null,
        max_bid: null,
        baseline_value: null,
        projection_summary: "",
        injury_severity_catalog: null,
        injury_severity_baseline: null,
        injury_multiplier: null,
        injury_component: null,
        replacement_key_used: null,
        replacement_value_used: null,
        surplus_basis: null,
        surplus_allocation_factor: null,
        notes: "Duplicate mlbId rows in valuation pool.",
      });
    }
  }

  const scenarioReports: Record<string, unknown>[] = [];
  const allFindings: SuspiciousValueFinding[] = [...globalFindings];
  let headlineChecks: HeadlinePlayerCheck[] | null = null;

  for (const sc of scenarios) {
    const wf = executeValuationWorkflow(pool, sc.input);
    if (!wf.ok) {
      scenarioReports.push({
        scenario_id: sc.id,
        ok: false,
        description: sc.description,
        issues: wf.issues,
      });
      continue;
    }
    const res = wf.response;
    const byId = poolById(pool);
    const { topSp } = topPitcherAuctions(res.valuations);
    scenarioReports.push({
      description: sc.description,
      ...scenarioSnapshot({
        scenarioId: sc.id,
        input: sc.input,
        response: res,
        pool,
      }),
    });
    if (sc.id === REFERENCE_SCENARIO_ID) {
      headlineChecks = buildHeadlinePlayerChecks(pool, res.valuations);
    }
    allFindings.push(
      ...collectSuspiciousValueFindings({
        scenarioId: sc.id,
        input: sc.input,
        response: res,
        poolById: byId,
        topSpAuction: topSp,
        draftedPickCount: sc.input.drafted_players.length,
      })
    );
  }

  if (!headlineChecks) {
    const ref = scenarios.find((s) => s.id === REFERENCE_SCENARIO_ID);
    if (ref) {
      const wf = executeValuationWorkflow(pool, ref.input);
      if (wf.ok) headlineChecks = buildHeadlinePlayerChecks(pool, wf.response.valuations);
    }
  }

  const summary = summarizeFindings(allFindings);
  const headline = headlineChecks ?? [];

  const report = {
    generatedAt: new Date().toISOString(),
    mongo,
    pool_size: pool.length,
    duplicate_mlb_ids: dupMlb,
    scenario_count: scenarios.length,
    scenarios: scenarioReports,
    suspicious_values: allFindings,
    summary_counts: {
      blockers: summary.blockers.length,
      important: summary.important.length,
      watch: summary.watch.length,
    },
    headline_player_checks: headline,
  };

  mkdirSync(path.dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(report, null, 2), "utf8");

  const okHeadline = mongo
    ? headline.filter((h) => h.status === "missing_from_pool" || h.status === "missing_from_valuations").length ===
      0
    : headline.filter((h) => h.status === "missing_from_valuations").length === 0;
  const allClear = summary.blockers.length === 0 && summary.important.length === 0 && okHeadline;

  console.log("\n--- Summary ---");
  console.log(`Blockers: ${summary.blockers.length}`);
  console.log(`Important: ${summary.important.length}`);
  console.log(`Watch: ${summary.watch.length}`);
  const headlineMissingValuations = headline.filter((h) => h.status === "missing_from_valuations").length;
  const headlineMissingPool = headline.filter((h) => h.status === "missing_from_pool").length;
  console.log(
    `Headline: missing_from_valuations=${headlineMissingValuations}  missing_from_pool=${headlineMissingPool}` +
      (mongo ? "" : " (synthetic pool — MLB names usually absent)")
  );
  console.log(`Wrote: ${jsonOut}`);
  if (allClear) console.log("\nStatus: ALL CLEAR (no suspicious findings at configured thresholds).");
  else console.log("\nStatus: NOT ALL CLEAR — inspect JSON suspicious_values and summary.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
