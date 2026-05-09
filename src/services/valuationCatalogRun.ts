import type { Logger } from "pino";
import type { NormalizedValuationInput } from "../types/brain";
import { loadMongoCatalogForEngine } from "../lib/mongoCatalogPipeline";
import {
  executeValuationWorkflow,
  type ValuationWorkflowResult,
} from "./valuationWorkflow";

/**
 * Load full lean catalog from Mongo, normalize, and run the valuation pipeline.
 * Keeps `routes/valuation` as HTTP wiring + logging.
 */
export async function runValuationWithMongoCatalog(
  normalized: NormalizedValuationInput,
  scope: { playerId?: string; position?: string } = {},
  log: Logger
): Promise<ValuationWorkflowResult> {
  const players = await loadMongoCatalogForEngine(log);
  return executeValuationWorkflow(players, normalized, scope);
}
