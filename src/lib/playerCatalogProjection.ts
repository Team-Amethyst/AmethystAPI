/**
 * Lean fields loaded for valuation, scarcity, simulation, and catalog batch.
 * Includes `projection` for baseline scoring/depth priors; excludes `stats`.
 * `_id` remains included by Mongoose unless explicitly excluded.
 */
export const PLAYER_CATALOG_LEAN_SELECT =
  "mlbId name team position positions age depthChartPosition injurySeverity adp tier value outlook projection" as const;
