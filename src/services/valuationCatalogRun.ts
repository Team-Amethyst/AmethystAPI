import type { Logger } from "pino";
import {
  httpCatalogMlbTeamHydrationEnabled,
  loadMongoCatalogForEngine,
} from "../lib/mongoCatalogPipeline";
import {
  addTimingMs,
  nowMs,
} from "../lib/valuationRequestTiming";
import type { ValuationRequestDiagnostics } from "../lib/valuationRequestTiming";
import type { NormalizedValuationInput } from "../types/brain";
import {
  executeValuationWorkflow,
  type ValuationWorkflowResult,
} from "./valuationWorkflow";

/**
 * Load full lean catalog from Mongo, normalize, and run the valuation pipeline.
 * Keeps `routes/valuation` as HTTP wiring + logging.
 *
 * By default skips MLB Stats API team hydration during this load (hot path).
 * Opt in with `AMETHYST_ALLOW_HTTP_MLB_TEAM_HYDRATE=1` for debugging only.
 */
export async function runValuationWithMongoCatalog(
  normalized: NormalizedValuationInput,
  scope: { playerId?: string; position?: string } = {},
  log: Logger,
  diagnostics?: ValuationRequestDiagnostics
): Promise<ValuationWorkflowResult> {
  const wall0 = performance.now();
  const skipMlbHydration = !httpCatalogMlbTeamHydrationEnabled();
  const diag = diagnostics;

  const tCat0 = diag ? nowMs() : performance.now();
  const players = await loadMongoCatalogForEngine(log, {
    skipMlbHydration,
    diagnostics: diag,
  });
  if (diag) addTimingMs(diag, "catalog_load_wall_ms", tCat0);
  const catalogMs = (diag ? nowMs() : performance.now()) - tCat0;

  const tWf0 = diag ? nowMs() : performance.now();
  const result = executeValuationWorkflow(players, normalized, scope, { diagnostics: diag });
  if (diag) addTimingMs(diag, "valuation_workflow_wall_ms", tWf0);
  const workflowMs = (diag ? nowMs() : performance.now()) - tWf0;

  const totalMs = performance.now() - wall0;

  if (diag) {
    log.info(
      {
        component: "ValuationCatalogRun",
        valuation_request_timing: true,
        catalog_load_wall_ms: Math.round(catalogMs),
        valuation_workflow_wall_ms: Math.round(workflowMs),
        valuation_catalog_run_total_ms: Math.round(totalMs),
        mlb_hydration_on_http_catalog: httpCatalogMlbTeamHydrationEnabled(),
        catalog_pool_size: players.length,
        timings_ms: diag.timings_ms,
        counts: diag.counts,
      },
      "valuation_request_timing"
    );
  }

  return result;
}
