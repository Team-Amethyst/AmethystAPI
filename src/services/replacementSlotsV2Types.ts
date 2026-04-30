export type ReplacementSlotsV2Result = {
  inflation_raw: number;
  /** Pre-clamp; equals `inflation_raw` until the inflation engine applies cap/floor. */
  inflation_factor_precap: number;
  pool_value_remaining: number;
  playerIdToSurplusBasis: Map<string, number>;
  draftablePoolSize: number;
  remaining_slots: number;
  min_bid: number;
  surplus_cash: number;
  total_surplus_mass: number;
  replacement_values_by_slot_or_position: Record<string, number>;
  fallback_reason: string | null;
  baselineOnly: boolean;
  /** When true, skip workflow cap/floor on the factor (already terminal). */
  skip_inflation_clamp: boolean;
};
