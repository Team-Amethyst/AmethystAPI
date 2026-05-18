/**
 * Stage 3b: integrated pitcher allocation + mid-draft spread.
 */
export type Stage3bPitcherHybridConfig = {
  enabled: boolean;
  eliteGateMin?: number;
  hybridLiftCap?: number;
  elitePartialLiftCap?: number;
  minCategoryProjection?: number;
  scarceSlotsOnly?: readonly string[];
  slotLiftScale?: Readonly<Record<string, number>>;
};

export type Stage3bPitcherAuctionConfig = {
  enabled: boolean;
  minSurplusBasis?: number;
  spWeightMult?: number;
  rpWeightMult?: number;
  promoteStarterMinSurplus?: number;
  /**
   * Floor surplus dollars for in-pool SP: max(current, sb * ratio).
   * Renormalizes within pitcher cohort to conserve pitcher bucket cash.
   */
  spSurplusDollarPerSb?: number;
};

/** Pitcher-only surplus tier ranks within a reserved budget share. */
export type Stage3bPitcherRelativeBudgetConfig = {
  enabled: boolean;
  pitcherSurplusShare?: number;
  pitcherStarFraction?: number;
  pitcherStarterFraction?: number;
  pitcherStarWeight?: number;
  pitcherStarterWeight?: number;
  pitcherDepthWeight?: number;
  minPitcherSurplusBasis?: number;
};

/** Linear curve path: modest SP/RP inflation multiplier when sb is meaningful. */
export type Stage3bPitcherLinearConfig = {
  enabled: boolean;
  spInflationMult?: number;
  rpInflationMult?: number;
  minSurplusBasis?: number;
  maxSurplusBasis?: number;
};

export type Stage3bMidDraftSpreadConfig = {
  enabled: boolean;
  minRemainingSlots?: number;
  maxRemainingSlots?: number;
  preferTieredSoft?: boolean;
  tieredFraction?: number;
  linearInflationFloor?: number;
};

export type Stage3bCalibration = {
  pitcherHybrid?: Stage3bPitcherHybridConfig;
  pitcherAuction?: Stage3bPitcherAuctionConfig;
  pitcherRelativeBudget?: Stage3bPitcherRelativeBudgetConfig;
  pitcherLinear?: Stage3bPitcherLinearConfig;
  midDraftSpread?: Stage3bMidDraftSpreadConfig;
};

export const STAGE3B_PITCHER_RELATIVE_DEFAULT: Stage3bPitcherRelativeBudgetConfig = {
  enabled: true,
  pitcherSurplusShare: 0.27,
  pitcherStarFraction: 0.14,
  pitcherStarterFraction: 0.38,
  pitcherStarWeight: 2.35,
  pitcherDepthWeight: 0.52,
  minPitcherSurplusBasis: 4,
};

export const STAGE3B_PITCHER_AUCTION_DEFAULT: Stage3bPitcherAuctionConfig = {
  enabled: true,
  minSurplusBasis: 5,
  spWeightMult: 1.18,
  rpWeightMult: 1.06,
  promoteStarterMinSurplus: 8,
  spSurplusDollarPerSb: 0.72,
};

export const STAGE3B_PITCHER_LINEAR_DEFAULT: Stage3bPitcherLinearConfig = {
  enabled: true,
  spInflationMult: 1.2,
  rpInflationMult: 1.06,
  minSurplusBasis: 5,
  maxSurplusBasis: 22,
};

export const STAGE3B_MID_DRAFT_DEFAULT: Stage3bMidDraftSpreadConfig = {
  enabled: true,
  minRemainingSlots: 45,
  maxRemainingSlots: 75,
  preferTieredSoft: false,
  linearInflationFloor: 0.33,
};

/** Explicit off — matrix Stage 3 baseline / audit comparisons. */
export const STAGE3B_DISABLED: Stage3bCalibration = {
  pitcherRelativeBudget: { enabled: false },
  pitcherAuction: { enabled: false },
  pitcherLinear: { enabled: false },
  midDraftSpread: { enabled: false },
};

/** Production Stage 3b — global tiering + targeted SP floors + mid-draft spread. */
export const DEFAULT_STAGE3B_CALIBRATION: Stage3bCalibration = {
  pitcherRelativeBudget: { enabled: false },
  pitcherAuction: STAGE3B_PITCHER_AUCTION_DEFAULT,
  pitcherLinear: STAGE3B_PITCHER_LINEAR_DEFAULT,
  midDraftSpread: STAGE3B_MID_DRAFT_DEFAULT,
};

export const STAGE3B_MATRIX_SCENARIOS: { id: string; label: string; cal?: Stage3bCalibration }[] = [
  { id: "stage3_baseline", label: "Stage 3 baseline (no 3b)", cal: STAGE3B_DISABLED },
  { id: "integrated_3b", label: "Integrated Stage 3b (ship candidate)", cal: DEFAULT_STAGE3B_CALIBRATION },
  { id: "mid_draft_only", label: "Mid-draft floor only", cal: { midDraftSpread: STAGE3B_MID_DRAFT_DEFAULT } },
  {
    id: "pitcher_relative_only",
    label: "Pitcher-relative budget only",
    cal: {
      pitcherRelativeBudget: STAGE3B_PITCHER_RELATIVE_DEFAULT,
      pitcherAuction: STAGE3B_PITCHER_AUCTION_DEFAULT,
    },
  },
  {
    id: "pitcher_relative_plus_linear",
    label: "Pitcher-relative + linear SP mult",
    cal: {
      pitcherRelativeBudget: STAGE3B_PITCHER_RELATIVE_DEFAULT,
      pitcherAuction: STAGE3B_PITCHER_AUCTION_DEFAULT,
      pitcherLinear: STAGE3B_PITCHER_LINEAR_DEFAULT,
    },
  },
];
