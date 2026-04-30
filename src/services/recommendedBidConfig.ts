export const RECOMMENDED_BID_TUNING = {
  pitcher_lambda_damp: {
    early: 0.52,
    mid: 0.44,
    late: 0.38,
  },
  early_elite_anchor_boost: 0.045,
  late_squeeze_floor: 0.35,
  hitter_floor: {
    depth_cutoff: 0.45,
    baseline_weight: 0.72,
    adjusted_mult: 1.6,
    adjusted_add: 4,
    adjusted_floor_add: 2,
  },
  hitter_star_floor: {
    depth_cutoff: 0.28,
    adjusted_add: 4,
    baseline_weight: 0.58,
  },
  global_depth_min_adjusted_mult: {
    depth_cutoff: 0.12,
    mult: 0.93,
  },
  late_hitter_anchor_cap: {
    depth_min: 0.52,
    baseline_min: 32,
    adjusted_to_baseline_max_ratio: 0.45,
    blend_weight: 0.22,
  },
  pitcher_hybrid_floor: {
    depth_cutoff: 0.5,
    baseline_min: 26,
    adjusted_max: 18,
    baseline_weight: 0.42,
    adjusted_mult: 2.55,
    adjusted_add: 10,
    absolute_floor_add: 3,
  },
  early_neutral_pitcher_cap: {
    index_delta_max: 0.08,
    adjusted_add: 5,
    adjusted_mult: 1.45,
  },
  hi_soft_cap: {
    max_base_mult: 1.15,
    add: 8,
  },
} as const;
