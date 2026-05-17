export type ReplacementSlotsV2Result = {
  inflation_raw: number;
  /** Pre-clamp; equals `inflation_raw` until the inflation engine applies cap/floor. */
  inflation_factor_precap: number;
  pool_value_remaining: number;
  playerIdToSurplusBasis: Map<string, number>;
  /** Slot-marginal surplus before hybrid lift (audit). */
  playerIdToSlotOnlySurplusBasis?: Map<string, number>;
  /** Hybrid lift amount applied over slot surplus (audit). */
  playerIdToHybridLift?: Map<string, number>;
  /** Greedy undrafted slot each player received (audit / explain). */
  playerIdToAssignedSlot?: Map<string, string>;
  /** Replacement floor at assignment (`marginalReplacement` in greedy pass). */
  playerIdToMarginalReplacement?: Map<string, number>;
  draftablePoolSize: number;
  /**
   * Undrafted players whose greedy slot assignment reduced remaining league demand
   * (same cardinality as `draftablePoolSize` on the main path).
   */
  draftablePlayerIds: string[];
  remaining_slots: number;
  min_bid: number;
  surplus_cash: number;
  total_surplus_mass: number;
  /** Tiered/adaptive auction curve: surplus dollars above min_bid per player (sums ≈ surplus_cash). */
  playerIdToSurplusDollars?: Map<string, number>;
  playerIdToSurplusTier?: Map<string, string>;
  playerIdToCurveWeight?: Map<string, number>;
  replacement_values_by_slot_or_position: Record<string, number>;
  fallback_reason: string | null;
  baselineOnly: boolean;
  /** When true, skip workflow cap/floor on the factor (already terminal). */
  skip_inflation_clamp: boolean;
};
