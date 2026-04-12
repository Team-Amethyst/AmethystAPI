/**
 * Lean fields loaded for valuation, scarcity, simulation, and catalog batch.
 * Excludes large `stats` / `projection` blobs from the hot path.
 * `_id` remains included by Mongoose unless explicitly excluded.
 */
export const PLAYER_CATALOG_LEAN_SELECT =
  "mlbId name team position adp tier value outlook" as const;
