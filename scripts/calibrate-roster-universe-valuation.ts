/**
 * Compare full valuation calibration: Mongo `loadMongoCatalogForEngine` pool vs
 * roster-universe-v1 **valuation_eligible** pool (in-memory only). **Never writes Mongo.**
 *
 * Requires: MONGO_URI, network (MLB team hydrate + roster universe MLB fetches).
 *
 *   pnpm calibrate:roster-universe-valuation -- --preview tmp/nfbc-data-mongo-preview.json
 *   pnpm calibrate:roster-universe-valuation -- --preview test-fixtures/market-adp/catalog-universe-preview-spotlight.json --out tmp/roster-universe-valuation-calibration.json
 *
 * Write guardrails (JSON `guardrails`): budget band, no ObjectId-shaped `getPlayerId` on roster pool,
 * spotlight rows in pool + valued, star mean abs % cap, top-25 overlap, Mongo ≥$20→≤$1.05 collapse count (must be 0 for
 * `safe_to_enable_writes`), full `collapsed_players` report (explain-mode), `requires_review` when any ≥$10 floor collapse exists.
 */
import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import mongoose from "mongoose";
import path from "path";

import {
  buildDraftroomStandardValuationInput,
  CALIBRATION_CATS_5X5,
  CALIBRATION_CATS_5X5_PLUS_HLD,
  CALIBRATION_CATS_SAVES_ONLY,
  draftroomUiDefaultRoster,
} from "../src/lib/calibrationDraftroomFixture";
import { hydratePlaceholderCatalogTeamsFromMlb } from "../src/lib/catalogTeamHydration";
import { runRosterCatalogUniverseBuild } from "../src/lib/mlbCatalogUniverse/runRosterCatalogUniverseBuild";
import { CATALOG_UNIVERSE_SPOTLIGHT_AUDIT } from "../src/lib/mlbCatalogUniverse/spotlightAuditTargets";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import {
  assessRosterUniverseWriteGuardrails,
  playerSyncDocsToValuationLeanPlayers,
  spotlightAuctionCompare,
  starStabilitySample,
  summarizeValuationResponse,
} from "../src/lib/rosterUniverseValuationCalibration";
import { executeValuationWorkflow, type ValuationWorkflowResult } from "../src/services/valuationWorkflow";
import type { NormalizedValuationInput } from "../src/types/brain";

dotenv.config();

const ROOT = path.resolve(__dirname, "..");
const MLB_API = "https://statsapi.mlb.com/api/v1";
const LAST_COMPLETED_SEASON = new Date().getFullYear() - 1;

const CALIBRATION_CATS_OBP = CALIBRATION_CATS_5X5.map((c) =>
  c.name === "AVG" ? { name: "OBP", type: "batting" as const } : c
);

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

function parseArgs(argv: string[]): { previewPath: string; outPath: string } {
  const a = argv.slice(2);
  let previewPath = path.join(ROOT, "tmp/nfbc-data-mongo-preview.json");
  let outPath = path.join(ROOT, "tmp/roster-universe-valuation-calibration.json");
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--preview" && a[i + 1]) {
      const raw = a[++i]!;
      previewPath = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
    } else if (a[i] === "--out" && a[i + 1]) {
      const raw = a[++i]!;
      outPath = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
    }
  }
  return { previewPath, outPath };
}

type Scenario = { id: string; input: NormalizedValuationInput };

function buildScenarios(): Scenario[] {
  const base = buildDraftroomStandardValuationInput({
    deterministic: true,
    seed: 42,
    inflation_model: "replacement_slots_v2",
  });
  return [
    { id: "standard_12_mixed", input: base },
    {
      id: "two_c",
      input: {
        ...base,
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "C" ? { ...s, count: 2 } : s
        ),
      },
    },
    {
      id: "five_of",
      input: {
        ...base,
        roster_slots: draftroomUiDefaultRoster().map((s) =>
          s.position === "OF" ? { ...s, count: 5 } : s
        ),
      },
    },
    { id: "al_only", input: { ...base, league_scope: "AL" } },
    { id: "nl_only", input: { ...base, league_scope: "NL" } },
    {
      id: "obp",
      input: { ...base, scoring_categories: CALIBRATION_CATS_OBP },
    },
    {
      id: "saves_only_pitching",
      input: { ...base, scoring_categories: CALIBRATION_CATS_SAVES_ONLY },
    },
    {
      id: "sv_hld",
      input: { ...base, scoring_categories: CALIBRATION_CATS_5X5_PLUS_HLD },
    },
  ];
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is required for Mongo baseline catalog (read-only).");
    process.exit(1);
  }
  const { previewPath, outPath } = parseArgs(process.argv);
  if (!existsSync(previewPath)) {
    console.error(`Preview not found: ${previewPath}`);
    process.exit(1);
  }
  const previewJson = JSON.parse(readFileSync(previewPath, "utf8"));

  const log = { warn: console.warn, info: console.info };

  await mongoose.connect(uri);
  let mongoPool;
  try {
    mongoPool = await loadMongoCatalogForEngine(log, { skipMlbHydration: false });
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const { report: universeReport, players: universeDocs } = await runRosterCatalogUniverseBuild({
    mlbApiBase: MLB_API,
    lastCompletedSeason: LAST_COMPLETED_SEASON,
    fetchJson,
    statsPageSize: 500,
    rosterTypes: ["40Man", "active", "fullSeason"],
    nfbcPreviewJson: previewJson,
    nfbcMlbIdsFromMongo: new Set(),
    existingMarketByMlbId: new Map(),
  });

  const rosterLean = playerSyncDocsToValuationLeanPlayers(universeDocs);
  const { players: rosterPool } = await hydratePlaceholderCatalogTeamsFromMlb(rosterLean, {
    log: (msg) => log.info({ msg }, "roster universe team hydrate"),
  });

  const scenarios = buildScenarios();
  const byScenario: Record<
    string,
    { mongo: ReturnType<typeof summarizeValuationResponse>; roster: ReturnType<typeof summarizeValuationResponse> }
  > = {};

  let mongoStdWf: ValuationWorkflowResult | null = null;
  let rosterStdWf: ValuationWorkflowResult | null = null;

  for (const sc of scenarios) {
    const mongoWf = executeValuationWorkflow(mongoPool, sc.input);
    const rosterWf = executeValuationWorkflow(rosterPool, sc.input);
    if (sc.id === "standard_12_mixed") {
      mongoStdWf = mongoWf;
      rosterStdWf = rosterWf;
    }
    byScenario[sc.id] = {
      mongo: summarizeValuationResponse(sc.id, mongoPool, sc.input, mongoWf),
      roster: summarizeValuationResponse(sc.id, rosterPool, sc.input, rosterWf),
    };
  }

  const std = scenarios[0]!;
  if (!mongoStdWf || !rosterStdWf || !mongoStdWf.ok || !rosterStdWf.ok) {
    console.error(
      JSON.stringify(
        {
          error: "standard_mixed_valuation_failed",
          mongo_ok: mongoStdWf?.ok,
          roster_ok: rosterStdWf?.ok,
          mongo_issues: mongoStdWf?.ok ? null : mongoStdWf?.issues,
          roster_issues: rosterStdWf?.ok ? null : rosterStdWf?.issues,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const mongoStd = summarizeValuationResponse(std.id, mongoPool, std.input, mongoStdWf);
  const rosterStd = summarizeValuationResponse(std.id, rosterPool, std.input, rosterStdWf);
  const spotlightIds = CATALOG_UNIVERSE_SPOTLIGHT_AUDIT.map((x) => x.mlbId);
  const spotlight = spotlightAuctionCompare(
    spotlightIds,
    mongoStdWf.response,
    rosterStdWf.response
  );
  const starSample = starStabilitySample(mongoStdWf.response, rosterStdWf.response, 25);

  const inputWithExplain = { ...std.input, explain_valuation_rows: true as const };
  const mongoExplainWf = executeValuationWorkflow(mongoPool, inputWithExplain);
  const rosterExplainWf = executeValuationWorkflow(rosterPool, inputWithExplain);

  const guardrails = assessRosterUniverseWriteGuardrails({
    mongoStd,
    rosterStd,
    starSample,
    spotlight,
    rosterPool,
    spotlightMlbIds: spotlightIds,
    mongoStandardVals: mongoStdWf.response.valuations,
    rosterStandardVals: rosterStdWf.response.valuations,
    mongoExplainVals: mongoExplainWf.ok ? mongoExplainWf.response.valuations : null,
    rosterExplainVals: rosterExplainWf.ok ? rosterExplainWf.response.valuations : null,
    mongoExplainOk: mongoExplainWf.ok,
    rosterExplainOk: rosterExplainWf.ok,
  });

  const starBoth = starSample.filter((s) => s.pct_change_vs_mongo != null);
  const meanAbsPct =
    starBoth.length > 0
      ? starBoth.reduce((s, x) => s + Math.abs(x.pct_change_vs_mongo ?? 0), 0) / starBoth.length
      : null;

  const side_by_side_standard_12_mixed = {
    pool_size: { mongo: mongoStd.eligible_pool_size, roster: rosterStd.eligible_pool_size },
    hitter_pitcher_valuation_rows: {
      mongo: { hitters: mongoStd.hitter_valuation_rows, pitchers: mongoStd.pitcher_valuation_rows },
      roster: { hitters: rosterStd.hitter_valuation_rows, pitchers: rosterStd.pitcher_valuation_rows },
    },
    hitter_auction_share: { mongo: mongoStd.hitter_auction_share, roster: rosterStd.hitter_auction_share },
    draftable_sum_ratio: {
      mongo: mongoStd.draftable_sum_to_league_budget_ratio,
      roster: rosterStd.draftable_sum_to_league_budget_ratio,
    },
    dollar_bands: {
      mongo: {
        ge_50: mongoStd.ge_50,
        ge_40: mongoStd.ge_40,
        ge_30: mongoStd.ge_30,
        ge_20: mongoStd.ge_20,
        near_one_dollar: mongoStd.near_one_dollar_count,
      },
      roster: {
        ge_50: rosterStd.ge_50,
        ge_40: rosterStd.ge_40,
        ge_30: rosterStd.ge_30,
        ge_20: rosterStd.ge_20,
        near_one_dollar: rosterStd.near_one_dollar_count,
      },
    },
    top25_auction_value: mongoStd.top25_auction_value.map((mRow, i) => ({
      rank: i + 1,
      mongo: mRow,
      roster: rosterStd.top25_auction_value[i] ?? null,
    })),
    top25_hitters: mongoStd.top25_hitters.map((mRow, i) => ({
      rank: i + 1,
      mongo: mRow,
      roster: rosterStd.top25_hitters[i] ?? null,
    })),
    top25_pitchers: mongoStd.top25_pitchers.map((mRow, i) => ({
      rank: i + 1,
      mongo: mRow,
      roster: rosterStd.top25_pitchers[i] ?? null,
    })),
    top10_sp: mongoStd.top10_sp.map((mRow, i) => ({
      rank: i + 1,
      mongo: mRow,
      roster: rosterStd.top10_sp[i] ?? null,
    })),
    top10_rp: mongoStd.top10_rp.map((mRow, i) => ({
      rank: i + 1,
      mongo: mRow,
      roster: rosterStd.top10_rp[i] ?? null,
    })),
    top_catchers: mongoStd.top_catchers.map((mRow, i) => ({
      rank: i + 1,
      mongo: mRow,
      roster: rosterStd.top_catchers[i] ?? null,
    })),
    replacement_values_by_slot_or_position: {
      mongo: mongoStd.replacement_values_by_slot_or_position,
      roster: rosterStd.replacement_values_by_slot_or_position,
    },
  };

  const payload = {
    preview_path: previewPath,
    universe_dry_run_report: universeReport,
    universe_valuation_eligible_lean_count: rosterPool.length,
    mongo_valuation_eligible_lean_count: mongoPool.length,
    universe_market_only_count: universeReport.market_only_count,
    universe_roster_context_count: universeReport.roster_context_count,
    note_market_only_roster_context:
      "market_only and roster_context rows are excluded from valuation pools by isValuationEligibleCatalogRow; counts come from universe_dry_run_report only.",
    scenarios: byScenario,
    side_by_side_standard_12_mixed,
    standard_mixed_spotlight_players: spotlight,
    standard_mixed_top25_star_stability: starSample,
    regressions: {
      top25_mongo_stars_mean_abs_pct_change_vs_roster: meanAbsPct,
      top25_stars_with_large_drawdown_gt_38pct: starSample.filter(
        (s) => s.pct_change_vs_mongo != null && s.pct_change_vs_mongo < -0.38
      ),
    },
    qualitative_notes: [
      "Expanded pool raises top-of-board stars modestly (same names, higher $) while concentrating marginal value across more bodies — expect a wider near-$1 tail.",
      "Some players who were mid-$ in the narrow Mongo-only z-score window can collapse toward the minimum bid when many similar profiles enter the pool (see regressions.top25_stars_with_large_drawdown_gt_38pct).",
      "Spotlight rows with mongo_auction_value null were absent from the Mongo valuation pool; roster-universe assigns finite dollars where projections clear value gates.",
      "market_only / roster_context: excluded from executeValuationWorkflow inputs; only universe_dry_run_report counts apply.",
    ],
    guardrails,
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        wrote: outPath,
        guardrails: {
          safe_to_enable_writes: guardrails.safe_to_enable_writes,
          requires_review: guardrails.requires_review,
          reasons: guardrails.reasons,
          soft_warnings: guardrails.soft_warnings,
          collapse_20_to_floor_count: guardrails.collapse_20_to_floor_count,
          collapse_10_to_floor_count: guardrails.collapse_10_to_floor_count,
          collapse_classification_counts: guardrails.collapse_classification_counts,
          top25_auction_overlap_count: guardrails.top25_auction_overlap_count,
          star_mean_abs_pct_change_vs_roster: guardrails.star_mean_abs_pct_change_vs_roster,
        },
        collapsed_players_preview: guardrails.collapsed_players.slice(0, 15),
        standard_mixed: {
          mongo: {
            eligible_pool_size: mongoStd.eligible_pool_size,
            draftable_pool_size: mongoStd.draftable_pool_size,
            hitter_rows: mongoStd.hitter_valuation_rows,
            pitcher_rows: mongoStd.pitcher_valuation_rows,
            draftable_ratio: mongoStd.draftable_sum_to_league_budget_ratio,
            hitter_share: mongoStd.hitter_auction_share,
            ge_50: mongoStd.ge_50,
            near_one: mongoStd.near_one_dollar_count,
          },
          roster_universe: {
            eligible_pool_size: rosterStd.eligible_pool_size,
            draftable_pool_size: rosterStd.draftable_pool_size,
            hitter_rows: rosterStd.hitter_valuation_rows,
            pitcher_rows: rosterStd.pitcher_valuation_rows,
            draftable_ratio: rosterStd.draftable_sum_to_league_budget_ratio,
            hitter_share: rosterStd.hitter_auction_share,
            ge_50: rosterStd.ge_50,
            near_one: rosterStd.near_one_dollar_count,
          },
        },
        spotlight_players: spotlight,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
