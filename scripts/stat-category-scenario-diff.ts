/**
 * Pairwise auction deltas vs standard_12_mixed Mongo calibration (read-only).
 * Usage: ts-node --project tsconfig.scripts.json scripts/stat-category-scenario-diff.ts [--json-out=tmp/stat-category-scenario-diff.json]
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import {
  buildDraftroomStandardValuationInput,
  CALIBRATION_CATS_5X5,
  CALIBRATION_CATS_5X5_PLUS_HLD,
  CALIBRATION_CATS_QS_REPLACES_W,
} from "../src/lib/calibrationDraftroomFixture";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { getPlayerId } from "../src/lib/playerId";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer } from "../src/types/brain";

const ROOT = path.resolve(__dirname, "..");

const BASE_OVER = {
  deterministic: true,
  seed: 42,
  inflation_model: "replacement_slots_v2" as const,
};

function buildScenarios(): {
  id: string;
  description: string;
  input: ReturnType<typeof buildDraftroomStandardValuationInput>;
}[] {
  const b = buildDraftroomStandardValuationInput(BASE_OVER);
  return [
    {
      id: "batting_obp",
      description: "OBP replaces AVG",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "AVG" ? { name: "OBP", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "batting_slg_replaces_avg",
      description: "SLG replaces AVG",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "AVG" ? { name: "SLG", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "batting_ops_replaces_avg",
      description: "OPS replaces AVG",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "AVG" ? { name: "OPS", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "batting_tb_replaces_rbi",
      description: "TB replaces RBI",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "RBI" ? { name: "TB", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "pitching_sv_hld_label",
      description: "SV+HLD replaces SV",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "SV" ? { name: "SV+HLD", type: "pitching" as const } : c
        ),
      },
    },
    {
      id: "pitching_hld_addon",
      description: "Standard 5×5 + HLD",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5_PLUS_HLD,
      },
    },
    {
      id: "pitching_k9_replaces_k",
      description: "K/9 replaces K",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "K" ? { name: "K/9", type: "pitching" as const } : c
        ),
      },
    },
    {
      id: "pitching_qs_replaces_w",
      description: "QS replaces W",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_QS_REPLACES_W,
      },
    },
  ];
}

function classifyHp(
  rows: { player_id: string; auction_value: number }[],
  pool: LeanPlayer[],
  ov: ReturnType<typeof positionOverridesFromRequest>
): { hitter$: number; pitcher$: number; hitterShare: number; pitcherShare: number } {
  const byId = new Map(pool.map((p) => [getPlayerId(p), p]));
  let hitter$ = 0,
    pitcher$ = 0;
  for (const r of rows) {
    const lp = byId.get(r.player_id);
    if (!lp) continue;
    if (isPitcherForBaseline(lp, ov)) pitcher$ += r.auction_value;
    else hitter$ += r.auction_value;
  }
  const t = hitter$ + pitcher$;
  return {
    hitter$,
    pitcher$,
    hitterShare: t > 0 ? hitter$ / t : 0,
    pitcherShare: t > 0 ? pitcher$ / t : 0,
  };
}

function topNamed(
  rows: { player_id: string; name: string; position: string; auction_value: number }[],
  pool: LeanPlayer[],
  ov: ReturnType<typeof positionOverridesFromRequest>,
  side: "hitter" | "pitcher",
  n: number
) {
  const byId = new Map(pool.map((p) => [getPlayerId(p), p]));
  const filt = rows.filter((r) => {
    const lp = byId.get(r.player_id);
    if (!lp) return false;
    const pit = isPitcherForBaseline(lp, ov);
    return side === "pitcher" ? pit : !pit;
  });
  filt.sort((a, b) => b.auction_value - a.auction_value);
  return filt.slice(0, n).map((r) => ({
    player_id: r.player_id,
    name: r.name,
    position: r.position,
    auction_value: Number(r.auction_value.toFixed(2)),
  }));
}

async function main(): Promise<void> {
  const jsonOut =
    process.argv.find((a) => a.startsWith("--json-out="))?.slice("--json-out=".length) ?? null;

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI required");
    process.exit(1);
  }
  await mongoose.connect(uri, scriptMongoConnectOptions());
  let pool: LeanPlayer[];
  try {
    pool = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const standardInput = buildDraftroomStandardValuationInput(BASE_OVER);
  const wfStd = executeValuationWorkflow(pool, standardInput, {});
  if (!wfStd.ok) {
    console.error(wfStd.issues);
    process.exit(1);
  }
  const stdRows = wfStd.response.valuations;
  const stdMap = new Map(stdRows.map((r) => [r.player_id, r.auction_value]));
  const ov = positionOverridesFromRequest(standardInput.position_overrides);
  const stdHp = classifyHp(stdRows, pool, ov);

  const scenarios = buildScenarios();
  const report: Record<string, unknown>[] = [];

  for (const sc of scenarios) {
    const wf = executeValuationWorkflow(pool, sc.input, {});
    if (!wf.ok) {
      report.push({ scenario: sc.id, ok: false, issues: wf.issues });
      continue;
    }
    const rows = wf.response.valuations;
    const hp = classifyHp(rows, pool, ov);
    const deltas = rows
      .map((r) => {
        const base = stdMap.get(r.player_id) ?? 0;
        return {
          player_id: r.player_id,
          name: r.name,
          position: r.position,
          auction_value: r.auction_value,
          delta_vs_standard: Number((r.auction_value - base).toFixed(2)),
        };
      })
      .sort((a, b) => Math.abs(b.delta_vs_standard) - Math.abs(a.delta_vs_standard));

    report.push({
      scenario: sc.id,
      description: sc.description,
      ok: true,
      hitterShare: hp.hitterShare,
      pitcherShare: hp.pitcherShare,
      hitterShare_delta_vs_standard: Number((hp.hitterShare - stdHp.hitterShare).toFixed(4)),
      scoring_category_warnings: wf.response.scoring_category_warnings ?? null,
      top20_by_abs_delta: deltas.slice(0, 20),
      topHitters: topNamed(rows, pool, ov, "hitter", 10),
      topPitchers: topNamed(rows, pool, ov, "pitcher", 10),
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    standard: {
      hitterShare: stdHp.hitterShare,
      pitcherShare: stdHp.pitcherShare,
      topHitters: topNamed(stdRows, pool, ov, "hitter", 10),
      topPitchers: topNamed(stdRows, pool, ov, "pitcher", 10),
    },
    scenarios: report,
  };

  console.log(JSON.stringify(payload, null, 2));

  if (jsonOut) {
    const abs = path.isAbsolute(jsonOut) ? jsonOut : path.join(ROOT, jsonOut);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(payload, null, 2));
    console.error(`\nWrote ${abs}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
