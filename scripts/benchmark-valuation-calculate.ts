/**
 * Local performance audit for the valuation hot path (Mongo + workflow + JSON size).
 *
 *   MONGO_URI=... pnpm exec ts-node --project tsconfig.scripts.json scripts/benchmark-valuation-calculate.ts
 *
 * Uses `createValuationRequestDiagnostics` + the same code paths as production
 * (`runValuationWithMongoCatalog` except debug mode, which calls `executeValuationWorkflow`
 * with `debugSignals: true` after an identical catalog load).
 */
import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import pino from "pino";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import {
  httpCatalogMlbTeamHydrationEnabled,
  loadMongoCatalogForEngine,
} from "../src/lib/mongoCatalogPipeline";
import { createValuationRequestDiagnostics } from "../src/lib/valuationRequestTiming";
import { runValuationWithMongoCatalog } from "../src/services/valuationCatalogRun";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { NormalizedValuationInput } from "../src/types/brain";

const WARMUP = 1;
const REPS = 10;
const FIXTURE = path.join(__dirname, "../test-fixtures/player-api/checkpoints/pre_draft.json");

const silent = pino({ level: "silent" });

function quantileMs(sortedAsc: number[], q: number): number {
  const s = sortedAsc;
  if (s.length === 0) return NaN;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return Math.round(s[lo]!);
  return Math.round(s[lo]! + (s[hi]! - s[lo]!) * (pos - lo));
}

function summarize(name: string, samples: Record<string, number[]>, serBytes: number[]) {
  console.log(`\n=== ${name} (${REPS} samples after ${WARMUP} warmup) ===`);
  const keys = Object.keys(samples).sort();
  for (const k of keys) {
    const v = samples[k];
    if (!v || v.length === 0) continue;
    const sorted = [...v].sort((a, b) => a - b);
    console.log(
      `  ${k.padEnd(42)} p50=${quantileMs(sorted, 0.5)}ms  p95=${quantileMs(sorted, 0.95)}ms  max=${Math.round(sorted[sorted.length - 1]!)}ms`
    );
  }
  if (serBytes.length) {
    const sortedB = [...serBytes].sort((a, b) => a - b);
    console.log(
    `  ${"response_body_bytes".padEnd(42)} p50=${quantileMs(sortedB, 0.5)}  p95=${quantileMs(sortedB, 0.95)}  max=${sortedB[sortedB.length - 1]}`
    );
  }
}

function mergeTiming(
  acc: Record<string, number[]>,
  diag: ReturnType<typeof createValuationRequestDiagnostics>,
  extra: Record<string, number>
) {
  for (const [k, v] of Object.entries(diag.timings_ms)) {
    if (!acc[k]) acc[k] = [];
    acc[k].push(v);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!acc[k]) acc[k] = [];
    acc[k].push(v);
  }
}

function baseBody(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  return {
    ...raw,
    num_teams: 12,
    total_budget: 312,
    league_scope: "Mixed",
    scoring_format: "5x5",
    inflation_model: "replacement_slots_v2",
    deterministic: true,
    seed: 42,
    explain_valuation_rows: false,
    user_team_id: "team_1",
  };
}

async function runScenario(
  label: string,
  mutate: (b: Record<string, unknown>) => void,
  opts: { debugSignals?: boolean } = {}
): Promise<void> {
  const samples: Record<string, number[]> = {};
  const serBytes: number[] = [];

  for (let i = 0; i < WARMUP + REPS; i++) {
    const body = baseBody();
    mutate(body);
    const parsed = parseValuationRequest(body);
    if (!parsed.success) {
      throw new Error(`${label}: parse failed: ${JSON.stringify(parsed.errors)}`);
    }
    const n = parsed.normalized as NormalizedValuationInput;

    const diag = createValuationRequestDiagnostics();
    const wall0 = performance.now();

    let outcome;
    if (opts.debugSignals) {
      const players = await loadMongoCatalogForEngine(silent, {
        skipMlbHydration: !httpCatalogMlbTeamHydrationEnabled(),
        diagnostics: diag,
      });
      outcome = executeValuationWorkflow(players, n, {}, {
        debugSignals: true,
        diagnostics: diag,
      });
    } else {
      outcome = await runValuationWithMongoCatalog(n, {}, silent, diag);
    }

    const tSer0 = performance.now();
    const payload = outcome.ok ? outcome.response : { ok: false, issues: outcome.issues };
    const json = JSON.stringify(payload);
    const serMs = performance.now() - tSer0;
    const totalMs = performance.now() - wall0;

    if (i < WARMUP) continue;
    if (!outcome.ok) {
      throw new Error(`${label}: workflow failed: ${outcome.issues.join("; ")}`);
    }

    serBytes.push(Buffer.byteLength(json, "utf8"));
    mergeTiming(samples, diag, {
      bench_total_wall_ms: totalMs,
      response_serialization_ms: serMs,
    });
  }

  summarize(label, samples, serBytes);
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI?.trim();
  if (!uri) {
    console.error("Set MONGO_URI (e.g. from .env) to run this benchmark against real Mongo.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  try {
    console.log("Engine benchmark — valuation hot path");
    console.log(`MONGO_URI: set (${uri.slice(0, 24)}…)`);
    console.log(
      `httpCatalogMlbTeamHydrationEnabled=${httpCatalogMlbTeamHydrationEnabled()} (MLB hydrate during catalog load when true)`
    );

    await runScenario("A: baseline (12-team mixed, r_slots_v2, no explain, no debug)", () => {});

    await runScenario("B: explain_valuation_rows=true", (b) => {
      b.explain_valuation_rows = true;
    });

    await runScenario("C: debugSignals=true (workflow only flag)", () => {}, {
      debugSignals: true,
    });

    const subsetIds = await (async () => {
      const players = await loadMongoCatalogForEngine(silent, {
        skipMlbHydration: !httpCatalogMlbTeamHydrationEnabled(),
      });
      return players
        .filter((p) => p.mlbId != null && Number.isFinite(p.mlbId as number))
        .slice(0, 100)
        .map((p) => String(p.mlbId));
    })();

    await runScenario("D: player_ids subset (~100)", (b) => {
      b.player_ids = subsetIds;
    });

    console.log("\nDone.");
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
