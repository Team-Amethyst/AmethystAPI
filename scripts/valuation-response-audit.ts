/**
 * Audits valuation JSON against checkpoint fixtures (mock catalog).
 * Run: pnpm exec ts-node --project tsconfig.scripts.json scripts/valuation-response-audit.ts
 */
import { readFileSync, readdirSync } from "fs";
import path from "path";
import type { LeanPlayer } from "../src/types/brain";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";

const MOCK_POOL = 512;
const mockPool: LeanPlayer[] = Array.from({ length: MOCK_POOL }, (_, i) => ({
  _id: `db_${i}`,
  mlbId: i + 1,
  name: `Player_${i + 1}`,
  team: "NYY",
  position: "OF",
  adp: i + 1,
  tier: (i % 5) + 1,
  value: Math.max(1, 90 - (i % 45)),
}));

const checkpointsDir = path.join(
  __dirname,
  "../test-fixtures/player-api/checkpoints"
);

function summarizeRow(r: {
  player_id: string;
  baseline_value: number;
  adjusted_value: number;
  scarcity_adjustment?: number;
  inflation_adjustment?: number;
  baseline_components?: { projection_component: number; scarcity_component: number };
}) {
  const bc = r.baseline_components;
  const decomp =
    (r.scarcity_adjustment ?? 0) + (r.inflation_adjustment ?? 0);
  const delta = r.adjusted_value - r.baseline_value;
  return {
    player_id: r.player_id,
    baseline: r.baseline_value,
    adjusted: r.adjusted_value,
    delta,
    scarcity_adj: r.scarcity_adjustment,
    infl_adj: r.inflation_adjustment,
    sum_adj: decomp,
    decomp_err: Math.abs(delta - decomp),
    proj_c: bc?.projection_component ?? null,
    scar_c: bc?.scarcity_component ?? null,
  };
}

function main(): void {
  const files = readdirSync(checkpointsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log("=== Valuation response field audit (mock catalog) ===\n");
  console.log(
    `Mock pool: ${MOCK_POOL} players, synthetic OF roster; projection stats empty → projection_component typically 0.\n`
  );

  for (const file of files) {
    const raw = readFileSync(path.join(checkpointsDir, file), "utf8");
    const parsed = parseValuationRequest(JSON.parse(raw) as object);
    if (!parsed.success) {
      console.log(file, "PARSE FAIL", parsed.errors.slice(0, 2));
      continue;
    }
    const out = executeValuationWorkflow(mockPool, parsed.normalized, {});
    if (!out.ok) {
      console.log(file, "WORKFLOW FAIL", out.issues.slice(0, 3));
      continue;
    }
    const res = out.response;
    const v0 = res.valuations[0];
    const s = summarizeRow(v0);
    const maxDecompErr = Math.max(
      ...res.valuations.map((row) =>
        Math.abs(
          row.adjusted_value -
            row.baseline_value -
            ((row.scarcity_adjustment ?? 0) + (row.inflation_adjustment ?? 0))
        )
      )
    );

    console.log(`--- ${file} ---`);
    console.log(
      `  aggregate: model=${res.inflation_model} inflation=${res.inflation_factor} raw=${res.inflation_raw} bounded=${res.inflation_bounded_by} budget_rem=${res.total_budget_remaining} pool_val=${res.pool_value_remaining} players_rem=${res.players_remaining} model=${res.valuation_model_version}`
    );
    console.log(
      `  context_v2: league_id=${res.context_v2?.scope.league_id} headline_snip=${(res.context_v2?.market_summary.headline ?? "").slice(0, 72)}…`
    );
    console.log(
      `  decomp: max |Δ − (scarcity_adj + infl_adj)| over all rows (expect ~0): ${maxDecompErr.toFixed(4)}`
    );
    console.log(`  first row sample:`, JSON.stringify(s));
    const explain = v0.explain_v2;
    if (explain) {
      console.log(
        `  explain_v2: list=${explain.list_value} auction_target=${explain.auction_target} conf=${explain.confidence}`
      );
    }
    console.log("");
  }

  console.log("=== Single-player filter (player_ids=[\"500\"]) on pre_draft.json ===");
  const pre = readFileSync(path.join(checkpointsDir, "pre_draft.json"), "utf8");
  const p = parseValuationRequest(JSON.parse(pre) as object);
  if (p.success) {
    const input = { ...p.normalized, player_ids: ["500"] };
    const one = executeValuationWorkflow(mockPool, input, { playerId: "500" });
    if (one.ok && one.response.valuations[0]) {
      const r = one.response.valuations[0];
      console.log(JSON.stringify(summarizeRow(r), null, 2));
      console.log("player_id in row (expect 500):", r.player_id);
      console.log("valuations.length:", one.response.valuations.length);
      console.log(
        "players_remaining (full pool):",
        one.response.players_remaining,
        "inflation_factor:",
        one.response.inflation_factor
      );
    } else if (!one.ok) {
      console.log("workflow", one.issues);
    }
  }
}

main();
