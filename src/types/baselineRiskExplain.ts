/**
 * Snapshot of catalog age / depth / injury factors applied in the baseline pipeline
 * (before inflation). Dollar fields use the same rounding as `age_depth_component`.
 */
export interface BaselineRiskExplainFields {
  /** Catalog age when present and valid; omitted when unknown (age multiplier then 1.0). */
  age_years?: number;
  age_multiplier: number;
  /** Resolved depth slot (1 starter … 4+ reserve) when available from catalog/projection/tier proxy. */
  depth_chart_position_resolved?: number;
  depth_multiplier: number;
  /** Clipped product of age × depth multipliers applied to pre-risk baseline dollars. */
  age_depth_combined_multiplier: number;
  /** 0 = healthy / unknown; 1–3 per `baselineInjuryAdjustments`. */
  injury_severity: number;
  injury_multiplier: number;
  /**
   * Hypothetical dollar delta vs pre-risk baseline if only the age curve were applied
   * (depth multiplier held at 1.0 in the same clip rules). Does not sum with
   * `depth_component` to `age_depth_component` when both factors interact.
   */
  age_component?: number;
  /**
   * Hypothetical dollar delta vs pre-risk baseline if only depth were applied
   * (age multiplier held at 1.0 in the same clip rules).
   */
  depth_component?: number;
}

/** Keys copied onto `baseline_components` and into `valuation_explain` (explain mode). */
export const BASELINE_RISK_EXPLAIN_KEYS: readonly (keyof BaselineRiskExplainFields)[] = [
  "age_years",
  "age_multiplier",
  "depth_chart_position_resolved",
  "depth_multiplier",
  "age_depth_combined_multiplier",
  "injury_severity",
  "injury_multiplier",
  "age_component",
  "depth_component",
];

export function pickBaselineRiskExplainFromMeta(
  meta: Record<string, unknown>
): Partial<BaselineRiskExplainFields> {
  const out: Partial<BaselineRiskExplainFields> = {};
  for (const k of BASELINE_RISK_EXPLAIN_KEYS) {
    if (k in meta && meta[k as string] !== undefined) {
      (out as Record<string, unknown>)[k] = meta[k as string];
    }
  }
  return out;
}
