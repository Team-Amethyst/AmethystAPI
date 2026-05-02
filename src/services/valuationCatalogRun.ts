import type { Logger } from "pino";
import Player from "../models/Player";
import { normalizeCatalogPlayers } from "../lib/playerCatalog";
import { PLAYER_CATALOG_LEAN_SELECT } from "../lib/playerCatalogProjection";
import type { NormalizedValuationInput } from "../types/brain";
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
  const rawDocs = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean();
  const players = normalizeCatalogPlayers(rawDocs, (msg) =>
    log.warn({ msg }, "catalog field coerced")
  );
  return executeValuationWorkflow(players, normalized, scope);
}
