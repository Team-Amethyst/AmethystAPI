export const REPLACEMENT_SLOTS_V2_MIN_BID = 1;

/** Slot-tail percentiles for replacement $ (see replacement v2 design notes). */
export const SLOT_REPLACEMENT_PERCENTILE: Record<string, number> = {
  C: 0.28,
  "1B": 0.22,
  "2B": 0.24,
  "3B": 0.23,
  SS: 0.24,
  OF: 0.2,
  CI: 0.26,
  MI: 0.26,
  UTIL: 0.32,
  SP: 0.35,
  RP: 0.34,
  P: 0.35,
  BN: 0.5,
};

export const SLOT_REPLACEMENT_DEFAULT_PERCENTILE = 0.24;

/**
 * Hybrid surplus: slot marginal remains primary; baseline strength lifts elites
 * assigned into saturated slots (e.g. SS) without UTIL/BN artifacts or ADP.
 */
export const HYBRID_SURPLUS_BASELINE_PERCENTILE = 0.18;
/** Scales baseline excess above undrafted-pool percentile (not slot replacement). */
export const HYBRID_SURPLUS_STRENGTH_MULTIPLIER = 2.15;
/** Only lift players whose slot marginal surplus is below this draftable-pool quantile. */
export const HYBRID_SURPLUS_SLOT_BELOW_PERCENTILE = 0.52;
/** Max hybrid surplus_basis for saturated-slot elite hitters (targets starter-tier spread). */
export const HYBRID_SURPLUS_MAX_LIFT_PER_PLAYER = 46;

/** Shared hybrid knobs (merged under scenario-specific calibration). */
export const HYBRID_SURPLUS_CORE = {
  hybridCap: HYBRID_SURPLUS_MAX_LIFT_PER_PLAYER,
  strengthMultiplier: HYBRID_SURPLUS_STRENGTH_MULTIPLIER,
  baselinePercentile: HYBRID_SURPLUS_BASELINE_PERCENTILE,
  slotBelowPercentile: HYBRID_SURPLUS_SLOT_BELOW_PERCENTILE,
};

/** Stage 1 shipped hybrid calibration (sensitivity baseline; hard gate 60.5). */
export const STAGE1_HYBRID_SURPLUS_CALIBRATION: HybridSurplusCalibration = {
  ...HYBRID_SURPLUS_CORE,
  eliteGateMin: 60.5,
  gateMode: "hard",
  smoothRampSpan: 4,
};

/** Stage 2: smooth, position-aware saturated-slot lift (no ADP, capped). */
export const DEFAULT_HYBRID_SURPLUS_CALIBRATION: HybridSurplusCalibration = {
  ...HYBRID_SURPLUS_CORE,
  eliteGateMin: 56,
  gateMode: "smooth",
  smoothRampSpan: 5,
  minCategoryProjection: 40,
  scarceSlotsOnly: ["C", "SS", "2B", "3B", "1B", "MI", "CI"],
  categoryStrongGateRelax: 4,
};

export type HybridSurplusGateMode = "hard" | "smooth";

export type HybridSurplusCalibration = {
  eliteGateMin: number;
  hybridCap: number;
  strengthMultiplier: number;
  gateMode?: HybridSurplusGateMode;
  /** Smooth ramp width above `eliteGateMin` when gateMode is smooth. */
  smoothRampSpan?: number;
  baselinePercentile?: number;
  slotBelowPercentile?: number;
  /** Scenario 5: require projection_component >= this (no ADP). */
  minCategoryProjection?: number;
  /** Scenario 5: assigned slot must be one of these (uppercase). */
  scarceSlotsOnly?: readonly string[];
  /** Scenario 5: lower effective gate by this much on scarce slots when category passes. */
  categoryStrongGateRelax?: number;
};
