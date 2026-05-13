/**
 * Factor influence audit: standard 12-team Mixed Draftroom roster, replacement_slots_v2,
 * real Mongo catalog. Read-only — no formula changes, no DB writes.
 *
 *   pnpm audit:valuation-factor-influence
 *
 * Writes tmp/valuation-factor-influence-audit.json
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import type { LeanPlayer, ValuedPlayer } from "../src/types/brain";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { getPlayerId } from "../src/lib/playerId";
import { isObjectIdStylePlayerId } from "../src/lib/catalogIdentityHelpers";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "valuation-factor-influence-audit.json");
const TOP_N = 100;

type BaselineComponents = NonNullable<ValuedPlayer["baseline_components"]>;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pickBc(row: ValuedPlayer): BaselineComponents {
  return (row.baseline_components ?? {}) as BaselineComponents;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function factorStats(
  values: number[],
  opts?: { materialAbs?: number }
): {
  avg_abs: number;
  max_positive_impact: number;
  max_negative_impact: number;
  materially_affected: number;
} {
  if (values.length === 0) {
    return {
      avg_abs: 0,
      max_positive_impact: 0,
      max_negative_impact: 0,
      materially_affected: 0,
    };
  }
  const abs = values.map((v) => Math.abs(v));
  const mat = opts?.materialAbs != null ? opts.materialAbs : 1e-9;
  const pos = values.filter((v) => v > 0);
  const neg = values.filter((v) => v < 0);
  return {
    avg_abs: mean(abs),
    max_positive_impact: pos.length ? Math.max(...pos) : 0,
    max_negative_impact: neg.length ? Math.min(...neg) : 0,
    materially_affected: values.filter((v) => Math.abs(v) >= mat).length,
  };
}

function topKByAbs(
  rows: Array<Record<string, unknown>>,
  key: string,
  k: number
): Array<Record<string, unknown>> {
  return [...rows]
    .sort((a, b) => Math.abs(num(b[key])) - Math.abs(num(a[key])))
    .slice(0, k);
}

async function loadPool(): Promise<LeanPlayer[]> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");
  await mongoose.connect(uri, scriptMongoConnectOptions());
  try {
    return await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const pool = await loadPool();
  const byPid = new Map<string, LeanPlayer>();
  for (const p of pool) {
    byPid.set(getPlayerId(p), p);
  }

  const input = buildDraftroomStandardValuationInput({
    explain_valuation_rows: true,
    inflation_model: "replacement_slots_v2",
    deterministic: true,
    seed: 42,
  });

  const wf = executeValuationWorkflow(pool, input, {});
  if (!wf.ok) {
    throw new Error(`workflow failed: ${wf.issues.join("; ")}`);
  }
  const res = wf.response;
  if (res.inflation_model !== "replacement_slots_v2") {
    throw new Error(`expected replacement_slots_v2, got ${res.inflation_model}`);
  }

  const sorted = [...res.valuations].sort((a, b) => b.auction_value - a.auction_value);
  const top = sorted.slice(0, TOP_N);

  const detailRows = top.map((row) => {
    const bc = pickBc(row);
    const ex = row.valuation_explain;
    const lp = byPid.get(row.player_id);
    const ageMeta = lp?.age != null && Number.isFinite(lp.age) && lp.age > 0;
    const depthMeta =
      lp?.depthChartPosition != null && Number.isFinite(lp.depthChartPosition as number);
    const injuryMeta = lp?.injurySeverity != null && lp.injurySeverity > 0;
    const hasAgeDepthDollar =
      Math.abs(num(bc.age_component)) >= 0.01 ||
      Math.abs(num(bc.depth_component)) >= 0.01 ||
      Math.abs(num(bc.age_depth_component)) >= 0.01;

    const suspicious: string[] = [];
    if (row.auction_value >= 30 && num(bc.projection_component) < 5) {
      suspicious.push("high_auction_weak_projection_component");
    }
    if (row.auction_value <= 5 && row.baseline_value >= 15) {
      suspicious.push("low_auction_high_baseline");
    }
    const rb = row.recommended_bid ?? row.auction_value;
    if (rb >= row.auction_value + 10) {
      suspicious.push("high_recommended_bid_vs_auction");
    }
    if (rb <= row.auction_value - 10) {
      suspicious.push("low_recommended_bid_vs_auction");
    }
    if (
      (ageMeta || depthMeta) &&
      !hasAgeDepthDollar &&
      num(bc.age_depth_combined_multiplier) === 1
    ) {
      suspicious.push("age_depth_metadata_but_no_dollar_component");
    }
    if (injuryMeta && num(bc.injury_component) === 0 && (bc.injury_multiplier ?? 1) >= 0.999) {
      suspicious.push("injury_metadata_but_negligible_injury_component");
    }
    if (isObjectIdStylePlayerId(row.player_id)) {
      suspicious.push("object_id_player_id");
    }

    return {
      player_id: row.player_id,
      name: row.name,
      position: row.position,
      team: row.team,
      projection_component: num(bc.projection_component),
      scarcity_component: num(bc.scarcity_component),
      age_component: num(bc.age_component),
      depth_component: num(bc.depth_component),
      injury_component: num(bc.injury_component),
      age_depth_component: num(bc.age_depth_component),
      age_multiplier: num(bc.age_multiplier),
      depth_multiplier: num(bc.depth_multiplier),
      injury_multiplier: num(bc.injury_multiplier),
      injury_severity: num(bc.injury_severity),
      baseline_value: row.baseline_value,
      replacement_key_used: ex?.replacement_key_used ?? null,
      replacement_value_used: ex?.replacement_value_used ?? null,
      surplus_basis: ex?.surplus_basis ?? row.debug_v2?.surplus_basis,
      inflation_factor: row.inflation_factor,
      auction_value: row.auction_value,
      recommended_bid: row.recommended_bid ?? null,
      team_adjusted_value: row.team_adjusted_value ?? null,
      recommended_minus_auction:
        row.recommended_bid != null ? row.recommended_bid - row.auction_value : null,
      catalog_age: lp?.age ?? null,
      catalog_depth_chart_position: lp?.depthChartPosition ?? null,
      catalog_injury_severity: lp?.injurySeverity ?? null,
      suspicious_flags: suspicious,
    };
  });

  const proj = detailRows.map((r) => r.projection_component as number);
  const sca = detailRows.map((r) => r.scarcity_component as number);
  const ageC = detailRows.map((r) => r.age_component as number);
  const depC = detailRows.map((r) => r.depth_component as number);
  const injC = detailRows.map((r) => r.injury_component as number);
  const ageDepth = detailRows.map((r) => r.age_depth_component as number);
  const surp = detailRows.map((r) => num(r.surplus_basis));
  const rbDeltas = detailRows
    .map((r) => r.recommended_minus_auction as number | null)
    .filter((x): x is number => x != null);

  const factor_influence_table = {
    projection_component: factorStats(proj),
    scarcity_component: factorStats(sca),
    age_component: factorStats(ageC, { materialAbs: 2 }),
    depth_component: factorStats(depC, { materialAbs: 2 }),
    injury_component: factorStats(injC, { materialAbs: 2 }),
    age_depth_component_combined: factorStats(ageDepth, { materialAbs: 2 }),
    surplus_basis: factorStats(surp, { materialAbs: 5 }),
    recommended_bid_minus_auction: factorStats(rbDeltas, { materialAbs: 10 }),
  };

  const top20 = {
    age_component: topKByAbs(detailRows, "age_component", 20),
    depth_component: topKByAbs(detailRows, "depth_component", 20),
    injury_component: topKByAbs(detailRows, "injury_component", 20),
    surplus_basis: topKByAbs(detailRows, "surplus_basis", 20),
    recommended_bid_gap: topKByAbs(
      detailRows.filter((r) => r.recommended_minus_auction != null),
      "recommended_minus_auction",
      20
    ),
  };

  const suspicious_players = detailRows.filter((r) => (r.suspicious_flags as string[]).length > 0);

  const interpretation = {
    projection_vs_scarcity:
      factor_influence_table.projection_component.avg_abs >=
      factor_influence_table.scarcity_component.avg_abs * 1.5
        ? "Projection dollars dominate scarcity on average in top 100 (expected in roto pipeline)."
        : "Scarcity and projection are closer in average absolute magnitude among top 100.",
    age_depth_injury:
      factor_influence_table.age_component.materially_affected +
        factor_influence_table.depth_component.materially_affected +
        factor_influence_table.injury_component.materially_affected <
        TOP_N * 0.05
        ? "Few top-100 players show >=$2 isolated age/depth/injury dollar lines — multipliers may be near 1 or components omitted when neutral."
        : "Meaningful age/depth/injury dollar components appear for a visible share of top 100.",
    surplus_basis:
      factor_influence_table.surplus_basis.materially_affected < TOP_N * 0.1
        ? "Surplus basis often small in magnitude for many top-100 stars (replacement_slots_v2 shape)."
        : "Surplus basis varies widely — replacement slot assignment is a visible driver for many top players.",
    recommended_bid_policy:
      factor_influence_table.recommended_bid_minus_auction.materially_affected > TOP_N * 0.15
        ? "Recommended bid deviates from auction_value by $10+ for many top-100 players — bid policy layer is active."
        : "Recommended bid tracks auction_value closely for most of top 100 after smoothing.",
  };

  const recommended_next_actions: string[] = [
    "If suspicious_flags accumulate for ObjectId player_id, prioritize catalog identity cleanup (mlbId backfill).",
    "If high_auction_weak_projection_component is frequent, review catalog projection vs scarcity prior mix — tuning is separate from this audit.",
    "If injury_metadata_but_negligible_injury_component appears for IL players, verify injurySeverity propagation from catalog sync.",
    "If age_depth_metadata_but_no_dollar_component is common, confirm catalog age / depthChartPosition fields and baseline risk chain thresholds.",
    "Re-run after any catalog or metadata fixes; keep explain_valuation_rows on for comparable rows.",
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    scenario: {
      roster: "draftroom_ui_default_12_team_mixed",
      inflation_model: res.inflation_model,
      inflation_factor: res.inflation_factor,
      pool_size: pool.length,
      top_n: TOP_N,
    },
    factor_influence_table,
    top_20_most_affected: top20,
    suspicious_players,
    interpretation,
    recommended_next_actions,
    top_100_detail: detailRows,
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(payload.scenario, null, 2));
  console.log("\n--- factor_influence_table (avg_abs / max+ / max- / materially_affected) ---");
  console.log(JSON.stringify(factor_influence_table, null, 2));
  console.log(`\nSuspicious rows in top ${TOP_N}: ${suspicious_players.length}`);
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
