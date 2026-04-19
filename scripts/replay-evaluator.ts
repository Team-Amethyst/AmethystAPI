/**
 * Historical / checkpoint replay — runs the valuation workflow over a manifest of
 * request fixtures with a synthetic in-memory player pool (no Mongo required).
 *
 * Usage: `pnpm replay-eval` (from repo root).
 *
 * Future: plug in real auction logs + end-of-season ROI for model scoring.
 */
import { readFileSync, existsSync } from "fs";
import path from "path";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer } from "../src/types/brain";

type Manifest = {
  schema_version: string;
  documentation?: string;
  player_pool_size: number;
  steps: { label: string; request_path: string }[];
};

function buildPool(size: number): LeanPlayer[] {
  return Array.from({ length: size }, (_, i) => ({
    _id: `replay_${i}`,
    mlbId: i + 1,
    name: `ReplayPlayer_${i + 1}`,
    team: "NYY",
    position: "OF",
    adp: i + 1,
    tier: (i % 5) + 1,
    value: Math.max(1, 90 - (i % 45)),
  }));
}

function rootDir(): string {
  return path.resolve(__dirname, "..");
}

function main(): void {
  const root = rootDir();
  const manifestPath = path.join(root, "test-fixtures/replay-evaluator/manifest.json");
  if (!existsSync(manifestPath)) {
    console.error("Missing manifest:", manifestPath);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const pool = buildPool(manifest.player_pool_size);
  const report: {
    label: string;
    ok: boolean;
    inflation_factor?: number;
    players_remaining?: number;
    error?: string;
  }[] = [];

  for (const step of manifest.steps) {
    const reqPath = path.join(root, step.request_path);
    if (!existsSync(reqPath)) {
      report.push({
        label: step.label,
        ok: false,
        error: `missing file: ${step.request_path}`,
      });
      continue;
    }
    const raw = JSON.parse(readFileSync(reqPath, "utf8")) as unknown;
    const parsed = parseValuationRequest(raw);
    if (!parsed.success) {
      report.push({
        label: step.label,
        ok: false,
        error: JSON.stringify(parsed.errors),
      });
      continue;
    }
    const outcome = executeValuationWorkflow(pool, parsed.normalized);
    if (!outcome.ok) {
      report.push({
        label: step.label,
        ok: false,
        error: outcome.issues.join("; "),
      });
      continue;
    }
    report.push({
      label: step.label,
      ok: true,
      inflation_factor: outcome.response.inflation_factor,
      players_remaining: outcome.response.players_remaining,
    });
  }

  console.log(JSON.stringify({ manifest: manifest.schema_version, report }, null, 2));
  const failed = report.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
