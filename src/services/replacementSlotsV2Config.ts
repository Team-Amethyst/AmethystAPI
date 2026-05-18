export const REPLACEMENT_SLOTS_V2_MIN_BID = 1;

/**
 * Stage 3b accepted opening-board slot demand (9-team keeper pre-draft).
 * Zero-keeper leagues use virtual demand consumption so empty boards match
 * the same inflation/replacement economics without seeding keepers.
 */
export const STAGE3B_OPENING_DRAFTABLE_DEMAND_SLOTS = 113;

/**
 * Per-team open-slot demand cap for real zero-keeper opening boards (no fake rosters).
 * Bench/relief depth is trimmed so anchor scarcity is not diluted across full roster capacity.
 */
/** ~20 slots/team keeps draftable pool near full league capacity while trimming bench dilution. */
export const TRUE_EMPTY_STRATEGIC_OPENING_SLOTS_PER_TEAM = 20;

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
/** Legacy replace-mode ceiling (Stage 1); incremental mode uses hybridLiftCap instead. */
export const HYBRID_SURPLUS_MAX_LIFT_PER_PLAYER = 46;
/** Default max surplus added on top of slot marginal (incremental lift mode). */
export const HYBRID_SURPLUS_DEFAULT_LIFT_CAP = 30;
/**
 * Post-hybrid mass vs slot-only (1.0 = budget-neutral redistribution).
 * Small values >1 allow modest inflation dilution for saturated-slot lifts.
 */
export const HYBRID_SURPLUS_MASS_GROWTH_CAP = 1.035;

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
  liftMode: "replace",
};

/** Stage 2 shipped hybrid calibration (audit baseline). */
export const STAGE2_HYBRID_SURPLUS_CALIBRATION: HybridSurplusCalibration = {
  ...HYBRID_SURPLUS_CORE,
  eliteGateMin: 56,
  gateMode: "smooth",
  smoothRampSpan: 5,
  minCategoryProjection: 40,
  scarceSlotsOnly: ["C", "SS", "2B", "3B", "1B", "MI", "CI"],
  categoryStrongGateRelax: 4,
  liftMode: "incremental",
  hybridLiftCap: HYBRID_SURPLUS_DEFAULT_LIFT_CAP,
  hybridTotalCeiling: 48,
  liftSoftness: 10,
  baselineSpreadPerPoint: 0.72,
  categoryLiftWeight: 0.18,
  elitePartialLiftCap: 16,
  massGrowthCap: HYBRID_SURPLUS_MASS_GROWTH_CAP,
  slotLiftScale: { C: 1.06, SS: 1.02, "3B": 1.04, "1B": 0.98, "2B": 1, MI: 1, CI: 1 },
};

/**
 * Stage 3: stronger saturated-slot → auction conversion (SS/3B), same pool/UTIL semantics.
 */
export const STAGE3_HYBRID_SURPLUS_CALIBRATION: HybridSurplusCalibration = {
  ...STAGE2_HYBRID_SURPLUS_CALIBRATION,
  hybridLiftCap: 34,
  elitePartialLiftCap: 22,
  baselineSpreadPerPoint: 0.82,
  categoryLiftWeight: 0.22,
  slotLiftScale: {
    C: 1.06,
    SS: 1.1,
    "3B": 1.06,
    "1B": 0.98,
    "2B": 1.02,
    MI: 1,
    CI: 1,
  },
};

/** Production default — Stage 3 calibration on Stage 2 foundation. */
export const DEFAULT_HYBRID_SURPLUS_CALIBRATION = STAGE3_HYBRID_SURPLUS_CALIBRATION;

export type HybridSurplusGateMode = "hard" | "smooth";
export type HybridSurplusLiftMode = "incremental" | "replace";

export type HybridSurplusCalibration = {
  eliteGateMin: number;
  /** Replace-mode total surplus ceiling (legacy). */
  hybridCap: number;
  strengthMultiplier: number;
  gateMode?: HybridSurplusGateMode;
  /** Smooth ramp width above `eliteGateMin` when gateMode is smooth. */
  smoothRampSpan?: number;
  baselinePercentile?: number;
  slotBelowPercentile?: number;
  /** Require projection_component >= this (no ADP). */
  minCategoryProjection?: number;
  /** Assigned slot must be one of these (uppercase). */
  scarceSlotsOnly?: readonly string[];
  /** Lower effective gate on scarce slots when category passes. */
  categoryStrongGateRelax?: number;
  /** incremental = slotSb + soft lift; replace = legacy min(cap, strength) total. */
  liftMode?: HybridSurplusLiftMode;
  /** Max surplus added above slot marginal (incremental mode). */
  hybridLiftCap?: number;
  /** Soft max final surplus_basis after lift. */
  hybridTotalCeiling?: number;
  /** Soft-cap knee for incremental lift curve (exp). */
  liftSoftness?: number;
  /** Baseline spread above gate so elites do not share identical surplus. */
  baselineSpreadPerPoint?: number;
  /** Extra lift scale from category projection above minCategoryProjection. */
  categoryLiftWeight?: number;
  /** Max add when slot surplus is already above pool median but still below ceiling. */
  elitePartialLiftCap?: number;
  /** Per-slot multiplier on incremental lift. */
  slotLiftScale?: Readonly<Record<string, number>>;
  /** Cap post-hybrid total mass vs slot-only (e.g. 1.045 = +4.5%). */
  massGrowthCap?: number;
};
