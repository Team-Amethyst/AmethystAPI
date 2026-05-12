/**
 * Read-only investigation: high-value Mongo → roster-universe floor collapses (esp. OF).
 * Does not write Mongo or change valuation formulas.
 *
 *   pnpm investigate:roster-universe-of-collapse -- --preview tmp/nfbc-data-mongo-preview.json
 */
import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import mongoose from "mongoose";
import path from "path";

import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { hydratePlaceholderCatalogTeamsFromMlb } from "../src/lib/catalogTeamHydration";
import { runRosterCatalogUniverseBuild } from "../src/lib/mlbCatalogUniverse/runRosterCatalogUniverseBuild";
import { CATALOG_UNIVERSE_SPOTLIGHT_AUDIT } from "../src/lib/mlbCatalogUniverse/spotlightAuditTargets";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { getPlayerId } from "../src/lib/playerId";
import {
  buildMongoToFloorCollapseRows,
  playerSyncDocsToValuationLeanPlayers,
  spotlightAuctionCompare,
  summarizeValuationResponse,
  top25AuctionPlayerOverlapFromValuations,
} from "../src/lib/rosterUniverseValuationCalibration";
import {
  diagnoseOfStyleCollapse,
  leanCarriesOutfieldToken,
  leanPrimaryOutfield,
  leanProjectionSummary,
  ROSTER_UNIVERSE_OF_COLLAPSE_FOCUS_IDS,
  rosterPlayersNewVsMongo,
  valuedRowExplainCore,
  valuationRowIsPrimaryOutfield,
} from "../src/lib/rosterUniverseOfCollapseInvestigation";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer, NormalizedValuationInput } from "../src/types/brain";
import type { ValuationResponse, ValuedPlayer } from "../src/types/valuation";

dotenv.config();

const ROOT = path.resolve(__dirname, "..");
const MLB_API = "https://statsapi.mlb.com/api/v1";
const LAST_COMPLETED_SEASON = new Date().getFullYear() - 1;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

function parseArgs(argv: string[]): { previewPath: string; outPath: string } {
  const a = argv.slice(2);
  let previewPath = path.join(ROOT, "tmp/nfbc-data-mongo-preview.json");
  let outPath = path.join(ROOT, "tmp/roster-universe-of-collapse-investigation.json");
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

function ofLeaderboard(vals: ValuedPlayer[], n: number) {
  const rows = vals.filter(valuationRowIsPrimaryOutfield);
  const byB = [...rows].sort((a, b) => b.baseline_value - a.baseline_value).slice(0, n);
  const byA = [...rows].sort((a, b) => b.auction_value - a.auction_value).slice(0, n);
  const pick = (v: ValuedPlayer) => {
    const ex = valuedRowExplainCore(v);
    return {
      player_id: v.player_id,
      name: v.name,
      position: v.position,
      baseline_value: ex.baseline_value,
      auction_value: ex.auction_value,
      replacement_key_used: ex.replacement_key_used,
      market_adp: ex.market_adp,
    };
  };
  return { by_baseline: byB.map(pick), by_auction: byA.map(pick) };
}

function variantMetrics(args: {
  label: string;
  note?: string;
  pool: LeanPlayer[];
  stdInput: NormalizedValuationInput;
  mongoExplainVals: ValuedPlayer[];
  mongoStdResponse: ValuationResponse;
}) {
  const explainInput = { ...args.stdInput, explain_valuation_rows: true as const };
  const wf = executeValuationWorkflow(args.pool, explainInput);
  if (!wf.ok) {
    return {
      variant_id: args.label,
      note: args.note,
      ok: false as const,
      issues: wf.issues,
    };
  }
  const v = wf.response.valuations;
  const collapseRows = buildMongoToFloorCollapseRows({
    mongoVals: args.mongoExplainVals,
    rosterVals: v,
    floorMax: 1.05,
  });
  const collapse20 = collapseRows.filter((c) => c.old_auction_value >= 20).length;
  const overlap = top25AuctionPlayerOverlapFromValuations(args.mongoStdResponse.valuations, v);
  const snap = summarizeValuationResponse(args.label, args.pool, args.stdInput, wf);
  const spotlightIds = CATALOG_UNIVERSE_SPOTLIGHT_AUDIT.map((x) => x.mlbId);
  const spotlight = spotlightAuctionCompare(spotlightIds, args.mongoStdResponse, wf.response);
  const spotlight_added = spotlight.filter(
    (s) => s.mongo_auction_value == null && s.roster_auction_value != null
  );
  return {
    variant_id: args.label,
    note: args.note,
    ok: true as const,
    collapse_20_to_floor_count: collapse20,
    collapse_10_to_floor_count: collapseRows.length,
    top25_auction_overlap_count: overlap.overlap_count,
    hitter_valuation_rows: snap.ok ? snap.hitter_valuation_rows : null,
    pitcher_valuation_rows: snap.ok ? snap.pitcher_valuation_rows : null,
    draftable_sum_to_league_budget_ratio: snap.ok ? snap.draftable_sum_to_league_budget_ratio : null,
    spotlight_now_valued_in_variant_count: spotlight_added.length,
    spotlight_now_valued_mlb_ids: spotlight_added.map((s) => s.mlbId),
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is required.");
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
  let mongoPool: LeanPlayer[];
  try {
    mongoPool = await loadMongoCatalogForEngine(log, { skipMlbHydration: false });
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const { players: universeDocs } = await runRosterCatalogUniverseBuild({
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

  const stdInput = buildDraftroomStandardValuationInput({
    deterministic: true,
    seed: 42,
    inflation_model: "replacement_slots_v2",
  });
  const explainInput = { ...stdInput, explain_valuation_rows: true as const };

  const mongoExplainWf = executeValuationWorkflow(mongoPool, explainInput);
  const rosterExplainWf = executeValuationWorkflow(rosterPool, explainInput);
  if (!mongoExplainWf.ok || !rosterExplainWf.ok) {
    console.error(
      JSON.stringify(
        {
          error: "explain_valuation_failed",
          mongo_ok: mongoExplainWf.ok,
          roster_ok: rosterExplainWf.ok,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const mongoVals = mongoExplainWf.response.valuations;
  const rosterVals = rosterExplainWf.response.valuations;
  const mongoBy = new Map(mongoVals.map((x) => [x.player_id, x]));
  const rosterBy = new Map(rosterVals.map((x) => [x.player_id, x]));
  const leanBy = new Map(rosterPool.map((p) => [getPlayerId(p), p]));
  const mongoLeanBy = new Map(mongoPool.map((p) => [getPlayerId(p), p]));

  const mongoIds = new Set(mongoPool.map((p) => getPlayerId(p)));
  const newVsMongo = rosterPlayersNewVsMongo({ rosterPool, mongoIds });
  let newCarriesOfToken = 0;
  for (const p of rosterPool) {
    if (mongoIds.has(getPlayerId(p))) continue;
    if (leanCarriesOutfieldToken(p)) newCarriesOfToken++;
  }

  const replMongo = mongoExplainWf.response.replacement_values_by_slot_or_position ?? {};
  const replRoster = rosterExplainWf.response.replacement_values_by_slot_or_position ?? {};

  const collapse_focus_table = ROSTER_UNIVERSE_OF_COLLAPSE_FOCUS_IDS.map((pid) => {
    const m = mongoBy.get(pid);
    const r = rosterBy.get(pid);
    const mLean = mongoLeanBy.get(pid);
    const rLean = leanBy.get(pid);
    const mEx = m ? valuedRowExplainCore(m) : null;
    const rEx = r ? valuedRowExplainCore(r) : null;
    const diag =
      m && r
        ? diagnoseOfStyleCollapse({
            old_replacement_key: mEx!.replacement_key_used,
            new_replacement_key: rEx!.replacement_key_used,
            old_replacement_value: mEx!.replacement_value_used,
            new_replacement_value: rEx!.replacement_value_used,
            old_surplus_basis: mEx!.surplus_basis,
            new_surplus_basis: rEx!.surplus_basis,
            old_baseline_value: mEx!.baseline_value,
            new_baseline_value: rEx!.baseline_value,
            old_auction_value: mEx!.auction_value,
            new_auction_value: rEx!.auction_value,
          })
        : { verdict: "projection_or_outlier_issue" as const, rationale: "missing row" };
    return {
      player_id: pid,
      name: m?.name ?? r?.name ?? null,
      mongo: m
        ? {
            projection_summary: mLean ? leanProjectionSummary(mLean) : {},
            ...mEx,
          }
        : null,
      roster: r
        ? {
            projection_summary: rLean ? leanProjectionSummary(rLean) : {},
            ...rEx,
          }
        : null,
      diagnostic_verdict: diag.verdict,
      diagnostic_rationale: diag.rationale,
    };
  });

  const projection_alignment_flags = ROSTER_UNIVERSE_OF_COLLAPSE_FOCUS_IDS.map((pid) => {
    const row = collapse_focus_table.find((r) => r.player_id === pid);
    const m = row?.mongo?.projection_summary as Record<string, unknown> | undefined;
    const r = row?.roster?.projection_summary as Record<string, unknown> | undefined;
    const keys = ["bat_plateAppearances", "bat_runs", "bat_hr"] as const;
    const diffs: Record<string, { mongo: unknown; roster: unknown }> = {};
    for (const k of keys) {
      if (m?.[k] !== r?.[k]) diffs[k] = { mongo: m?.[k], roster: r?.[k] };
    }
    return {
      player_id: pid,
      lean_projection_fields_differ: Object.keys(diffs).length > 0,
      diffs,
    };
  });
  const projection_stats_misaligned_for_all_focus_players =
    projection_alignment_flags.length > 0 &&
    projection_alignment_flags.every((f) => f.lean_projection_fields_differ);

  const newPrimaryOfLean = rosterPool.filter((p) => !mongoIds.has(getPlayerId(p)) && leanPrimaryOutfield(p));
  const newOfTopByAuction = [...newPrimaryOfLean]
    .map((p) => {
      const v = rosterBy.get(getPlayerId(p));
      if (!v) return null;
      const ex = valuedRowExplainCore(v);
      return {
        player_id: getPlayerId(p),
        name: p.name,
        position: p.position,
        catalog_rank: p.catalog_rank ?? null,
        market_adp: p.market_adp ?? null,
        projection_summary: leanProjectionSummary(p),
        baseline_value: ex.baseline_value,
        auction_value: ex.auction_value,
        replacement_key_used: ex.replacement_key_used,
        replacement_value_used: ex.replacement_value_used,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => b.auction_value - a.auction_value)
    .slice(0, 50);

  const of_replacement_inspection = {
    mongo_replacement_OF: replMongo.OF ?? replMongo.of ?? null,
    roster_replacement_OF: replRoster.OF ?? replRoster.of ?? null,
    mongo_replacement_slice: {
      OF: replMongo.OF,
      OF1: (replMongo as Record<string, number>).OF1,
      UTIL: replMongo.UTIL,
    },
    roster_replacement_slice: {
      OF: replRoster.OF,
      OF1: (replRoster as Record<string, number>).OF1,
      UTIL: replRoster.UTIL,
    },
    primary_outfield_valuation_row_counts: {
      mongo: mongoVals.filter(valuationRowIsPrimaryOutfield).length,
      roster: rosterVals.filter(valuationRowIsPrimaryOutfield).length,
    },
    new_primary_outfield_lean_players_not_in_mongo: newVsMongo.new_primary_outfield_count,
    mongo_top50_primary_of: ofLeaderboard(mongoVals, 50),
    roster_top50_primary_of: ofLeaderboard(rosterVals, 50),
  };

  const alternatives_not_run = [
    {
      id: "mongo_pool_for_replacement_only",
      reason:
        "Engine path `replacement_slots_v2` derives replacement from the same undrafted/scoped pool as baselines; there is no supported hook to value the expanded universe while freezing replacement to the narrow Mongo subset without code changes.",
    },
    {
      id: "of_replacement_percentile_tuning",
      reason:
        "Percentiles live in `replacementSlotsV2Config.ts` (`SLOT_REPLACEMENT_PERCENTILE.OF`); adjusting them is a tuning change, intentionally skipped per instructions.",
    },
  ];

  const poolDropNewPrimaryOf = rosterPool.filter((p) => mongoIds.has(getPlayerId(p)) || !leanPrimaryOutfield(p));
  const poolDropNewOfNoAdp = rosterPool.filter(
    (p) =>
      mongoIds.has(getPlayerId(p)) ||
      !leanPrimaryOutfield(p) ||
      (p.market_adp != null && Number.isFinite(p.market_adp))
  );
  const poolDropNewOfDeepCatalog = rosterPool.filter(
    (p) =>
      mongoIds.has(getPlayerId(p)) ||
      !leanPrimaryOutfield(p) ||
      (p.catalog_rank ?? 9999) < 3500
  );
  const poolDropNewOutfieldTokenNotInMongo = rosterPool.filter(
    (p) => mongoIds.has(getPlayerId(p)) || !leanCarriesOutfieldToken(p)
  );

  const mongoStdWf = executeValuationWorkflow(mongoPool, stdInput);
  if (!mongoStdWf.ok) {
    console.error(JSON.stringify({ error: "mongo_std_failed", issues: mongoStdWf.issues }, null, 2));
    process.exit(1);
  }

  const variantRows = [
    variantMetrics({
      label: "baseline_roster_universe",
      pool: rosterPool,
      stdInput,
      mongoExplainVals: mongoVals,
      mongoStdResponse: mongoStdWf.response,
    }),
    variantMetrics({
      label: "expanded_minus_new_primary_outfield_not_in_mongo",
      note: "Removes roster-only LF/CF/RF/OF bodies not present in Mongo catalog — stress test for displacement hypothesis.",
      pool: poolDropNewPrimaryOf,
      stdInput,
      mongoExplainVals: mongoVals,
      mongoStdResponse: mongoStdWf.response,
    }),
    variantMetrics({
      label: "expanded_minus_new_primary_of_without_market_adp",
      note: "Stricter gate simulation: drop new primary OF if they lack numeric market_adp.",
      pool: poolDropNewOfNoAdp,
      stdInput,
      mongoExplainVals: mongoVals,
      mongoStdResponse: mongoStdWf.response,
    }),
    variantMetrics({
      label: "expanded_minus_new_primary_of_deep_catalog_rank",
      note: "Stricter gate simulation: drop new primary OF with catalog_rank >= 3500.",
      pool: poolDropNewOfDeepCatalog,
      stdInput,
      mongoExplainVals: mongoVals,
      mongoStdResponse: mongoStdWf.response,
    }),
    variantMetrics({
      label: "expanded_minus_new_outfield_token_carriers_not_in_mongo",
      note:
        "Broader trim: drop any roster-only player whose lean positions include LF/CF/RF/OF (captures DH/UTIL/CI types with OF eligibility).",
      pool: poolDropNewOutfieldTokenNotInMongo,
      stdInput,
      mongoExplainVals: mongoVals,
      mongoStdResponse: mongoStdWf.response,
    }),
  ];

  const recommendationCore = (() => {
    const base = variantRows.find((r) => r.variant_id === "baseline_roster_universe");
    const dropPrimaryOf = variantRows.find(
      (r) => r.variant_id === "expanded_minus_new_primary_outfield_not_in_mongo"
    );
    const dropOfToken = variantRows.find(
      (r) => r.variant_id === "expanded_minus_new_outfield_token_carriers_not_in_mongo"
    );
    if (
      !base ||
      !("ok" in base) ||
      !base.ok ||
      !dropPrimaryOf ||
      !("ok" in dropPrimaryOf) ||
      !dropPrimaryOf.ok ||
      !dropOfToken ||
      !("ok" in dropOfToken) ||
      !dropOfToken.ok
    ) {
      return {
        letter: "D" as const,
        summary:
          "A pool-variant valuation failed validation — keep roster-universe dry-run until workflows succeed for all counterfactual pools.",
      };
    }
    const c20b = base.collapse_20_to_floor_count;
    const c20Primary = dropPrimaryOf.collapse_20_to_floor_count;
    const c20Token = dropOfToken.collapse_20_to_floor_count;
    if (c20b > 0 && c20Token === 0) {
      return {
        letter: "A" as const,
        summary:
          "Floor collapses disappear when roster-only players carrying any OF token are removed — marginal OF/DH/UTIL eligibility plus a higher OF replacement bar explain the dollars, not bad projection rows for the five names. Exec signoff on wide-pool economics is coherent; optional letter B if those bodies should not enter valuation_eligible.",
      };
    }
    if (c20b > 0 && c20Token > 0 && c20Token < c20b) {
      return {
        letter: "B" as const,
        summary:
          "Broad OF-token trim materially reduced ≥$20 collapses but did not clear them — tighten eligibility for multi-position / DH-adjacent profiles and re-run calibration before writes.",
      };
    }
    if (c20b > 0 && c20Primary === c20b && c20Token === c20b) {
      return {
        letter: "A" as const,
        summary:
          "Neither primary-OF-only nor full OF-token roster trims changed ≥$20 collapses — competition is coming through the shared OF replacement lane without requiring new roster-only OF rows specifically; dollars-at-floor still reflect wider-pool surplus math under a fixed budget.",
      };
    }
    if (c20b > 0 && c20Token >= c20b) {
      return {
        letter: "A" as const,
        summary:
          "OF-token trim did not reduce ≥$20 collapses versus baseline — the collapse mechanism is not well isolated by subtracting roster-only outfield carriers alone; review remains prudent before writes even though classifications look like wider-pool corrections.",
      };
    }
    return {
      letter: "A" as const,
      summary: "No ≥$20 floor collapses on baseline — nothing to gate here.",
    };
  })();

  const baseVariant = variantRows.find((r) => r.variant_id === "baseline_roster_universe");
  const c20Baseline =
    baseVariant && "ok" in baseVariant && baseVariant.ok ? baseVariant.collapse_20_to_floor_count : 0;

  const recommendation_letter =
    projection_stats_misaligned_for_all_focus_players && c20Baseline > 0 && recommendationCore.letter === "A"
      ? "B"
      : recommendationCore.letter;
  const recommendation_summary =
    projection_stats_misaligned_for_all_focus_players && c20Baseline > 0 && recommendationCore.letter === "A"
      ? `${recommendationCore.summary} All five focus players also show different Mongo vs roster-universe blended batting counting stats (PA/runs/HR) for the same MLB id — reconcile projection inputs before treating the floor as purely economic.`
      : recommendationCore.summary;

  const payload = {
    preview_path: previewPath,
    notes: {
      market_only_vs_valuation_eligible:
        "Roster-universe valuation pool already excludes market_only/roster_context at `playerSyncDocsToValuationLeanPlayers`; dry-run counts in universe build are informational only.",
      letter_C_follow_up:
        "If the same eligible bodies should price less harshly at the OF margin without shrinking the pool, the next lever is replacement v2 config (e.g. `SLOT_REPLACEMENT_PERCENTILE.OF`) — not exercised in this read-only pass.",
    },
    new_vs_mongo_counts: { ...newVsMongo, new_roster_only_carries_outfield_token: newCarriesOfToken },
    projection_alignment_flags,
    collapse_focus_table,
    displaced_by_new_primary_outfield_top50: newOfTopByAuction,
    of_replacement_inspection,
    alternatives_not_run_requires_engine_or_tuning: alternatives_not_run,
    alternative_variant_metrics: variantRows,
    recommendation_letter,
    recommendation_summary,
    recommendation_core_letter: recommendationCore.letter,
    recommendation_core_summary: recommendationCore.summary,
    projection_stats_misaligned_for_all_focus_players,
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        wrote: outPath,
        recommendation_letter,
        recommendation_summary,
        projection_stats_misaligned_for_all_focus_players,
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
