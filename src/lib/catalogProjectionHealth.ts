/**
 * Cheap projection-diversity health check for the valuation catalog.
 *
 * Why this exists:
 * - On 2026-05-13 production traffic to `POST /valuation/calculate` returned 834 valuations all
 *   priced at `baseline_value=10.35` / `auction_value=10.35`. Diagnosis showed every row had the
 *   same `projection_component=11.13` and `age_years=24` — i.e. the projection-driven baseline
 *   collapsed onto a single constant because the upstream `projection.batting/pitching` blob was
 *   empty for the entire catalog snapshot loaded into the in-process cache.
 * - `value` (catalog dollars) on the same rows was clearly varied (Judge 112, Ohtani 110,
 *   Verlander 11, Trout 3, …) so the catalog wasn't empty — only the projection sub-document
 *   was. Without a guardrail the Engine silently served degenerate prices.
 *
 * This module gives the catalog pipeline + workflow a single source of truth for "are
 * projections actually populated?". It samples a small slice (top-N by catalog `value`) and
 * counts distinct values across a handful of strong fields. If the diversity is below threshold
 * the caller logs a `catalog_projection_collapsed` warning that operators can wire into alerts.
 *
 * No fail-closed semantics — the Engine still serves a response so Draftroom doesn't break, but
 * the log message + `valuation_context_warnings` make the failure mode visible instead of silent.
 *
 * Tests: `test/catalogProjectionHealth.test.ts`.
 */

import type { LeanPlayer } from "../types/brain";

export type ProjectionHealth = {
  /** `true` when projections look populated enough to compute meaningful baselines. */
  ok: boolean;
  /** Number of rows actually inspected (may be < `sampleSize` for tiny catalogs). */
  sampled: number;
  /** Per-field distinct-value count over the sample. */
  distinct: {
    batting_hr: number;
    batting_runs: number;
    pitching_strikeouts: number;
    pitching_innings: number;
    catalog_value: number;
  };
  /** Distinct catalog `value` across the sample (sanity check; should always be > 1). */
  /** Short human-readable reason when `ok=false`. */
  reason?: string;
};

const DEFAULT_SAMPLE_SIZE = 200;
const MIN_DISTINCT_FOR_HEALTHY = 5;

type ProjectionNode = Record<string, unknown> | undefined;

function projectionOf(p: LeanPlayer, section: "batting" | "pitching"): ProjectionNode {
  const proj = p.projection as
    | Record<string, ProjectionNode | undefined>
    | undefined;
  return proj?.[section];
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function distinctCount(values: ReadonlyArray<number | null>): number {
  const seen = new Set<number>();
  for (const v of values) {
    if (v == null) continue;
    seen.add(v);
  }
  return seen.size;
}

/**
 * Inspect the top `sampleSize` rows by catalog `value` (or all rows for small catalogs) and
 * report distinct counts for a handful of strong projection fields. We use `value`-ordered
 * sampling because that surfaces the rows that matter most for auction pricing — the top of
 * the board. A collapsed bottom-of-bench is normal; a collapsed top-200 is the symptom.
 */
export function assessCatalogProjectionHealth(
  players: ReadonlyArray<LeanPlayer>,
  sampleSize: number = DEFAULT_SAMPLE_SIZE
): ProjectionHealth {
  if (players.length === 0) {
    return {
      ok: false,
      sampled: 0,
      distinct: {
        batting_hr: 0,
        batting_runs: 0,
        pitching_strikeouts: 0,
        pitching_innings: 0,
        catalog_value: 0,
      },
      reason: "empty_catalog",
    };
  }

  const sorted = [...players].sort(
    (a, b) => (b.value ?? 0) - (a.value ?? 0)
  );
  const slice = sorted.slice(0, Math.max(1, Math.min(sampleSize, sorted.length)));
  const sampled = slice.length;

  const battingHr: (number | null)[] = [];
  const battingRuns: (number | null)[] = [];
  const pitchingK: (number | null)[] = [];
  const pitchingIp: (number | null)[] = [];
  const catalogValues: (number | null)[] = [];

  for (const p of slice) {
    const bat = projectionOf(p, "batting");
    const pit = projectionOf(p, "pitching");
    battingHr.push(num(bat?.hr));
    battingRuns.push(num(bat?.runs));
    pitchingK.push(num(pit?.strikeouts));
    pitchingIp.push(num(pit?.innings));
    catalogValues.push(num(p.value));
  }

  const distinct = {
    batting_hr: distinctCount(battingHr),
    batting_runs: distinctCount(battingRuns),
    pitching_strikeouts: distinctCount(pitchingK),
    pitching_innings: distinctCount(pitchingIp),
    catalog_value: distinctCount(catalogValues),
  };

  /*
   * Healthy = at least one batting field AND one pitching field show diversity (>= threshold).
   * That tolerates catalogs where only hitters or only pitchers have projections wired (e.g.
   * during a partial sync) while still catching the global-empty failure mode we saw in prod.
   */
  const battingDiverse =
    distinct.batting_hr >= MIN_DISTINCT_FOR_HEALTHY ||
    distinct.batting_runs >= MIN_DISTINCT_FOR_HEALTHY;
  const pitchingDiverse =
    distinct.pitching_strikeouts >= MIN_DISTINCT_FOR_HEALTHY ||
    distinct.pitching_innings >= MIN_DISTINCT_FOR_HEALTHY;

  if (battingDiverse && pitchingDiverse) {
    return { ok: true, sampled, distinct };
  }

  const reasons: string[] = [];
  if (!battingDiverse) reasons.push("batting_projection_uniform");
  if (!pitchingDiverse) reasons.push("pitching_projection_uniform");

  return {
    ok: false,
    sampled,
    distinct,
    reason: reasons.join(","),
  };
}

/**
 * Cheap variance check on the *output* of `scoringAwareBaselinePlayers`. Detects the case where
 * the workflow produced a near-uniform baseline across the pool (the production symptom even
 * when individual catalog `value`s were varied — see module header).
 */
export function isBaselineOutputCollapsed(
  baselines: ReadonlyArray<{ value: number }>,
  sampleSize: number = DEFAULT_SAMPLE_SIZE
): boolean {
  if (baselines.length < MIN_DISTINCT_FOR_HEALTHY) return false;
  const slice = baselines.slice(0, Math.min(sampleSize, baselines.length));
  const seen = new Set<number>();
  for (const p of slice) {
    if (typeof p.value === "number" && Number.isFinite(p.value)) {
      seen.add(Number(p.value.toFixed(2)));
    }
  }
  return seen.size < MIN_DISTINCT_FOR_HEALTHY;
}
