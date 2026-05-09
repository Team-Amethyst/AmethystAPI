import type { InflationModel } from "../types/core";

/**
 * Default inflation model when the request omits `inflation_model`.
 * Slot-aware surplus allocation (`replacement_slots_v2`) is the official auction-dollar path.
 */
export const DEFAULT_INFLATION_MODEL: InflationModel = "replacement_slots_v2";
