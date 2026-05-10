/**
 * Lean fields loaded for valuation, scarcity, simulation, and catalog batch.
 * Includes `projection` for baseline scoring/depth priors; excludes `stats`.
 * `_id` remains included by Mongoose unless explicitly excluded.
 */
export const PLAYER_CATALOG_LEAN_SELECT =
  "mlbId catalogKind name team position positions age depthChartPosition injurySeverity catalog_rank catalog_tier adp tier value outlook projection market_adp market_adp_source market_adp_updated_at market_adp_min market_adp_max market_pick_count" as const;
