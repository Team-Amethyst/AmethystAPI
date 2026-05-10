import type { LeanPlayer } from "../types/brain";
import type { BaselineRiskExplainFields } from "../types/baselineRiskExplain";
import { applyAgeDepthAdjustment } from "./baselineAgeDepthAdjustments";
import { applyInjuryAdjustment } from "./baselineInjuryAdjustments";

function buildBaselineRiskExplain(
  player: LeanPlayer,
  ad: ReturnType<typeof applyAgeDepthAdjustment>,
  inj: ReturnType<typeof applyInjuryAdjustment>
): BaselineRiskExplainFields {
  const ageYears =
    typeof player.age === "number" &&
    Number.isFinite(player.age) &&
    player.age > 0
      ? Math.trunc(player.age)
      : undefined;
  const out: BaselineRiskExplainFields = {
    age_multiplier: ad.ageMultiplier,
    depth_multiplier: ad.depthMultiplier,
    age_depth_combined_multiplier: ad.ageDepthCombinedMultiplier,
    injury_severity: inj.injurySeverity,
    injury_multiplier: inj.injuryMultiplier,
  };
  if (ageYears != null) {
    out.age_years = ageYears;
  }
  if (ad.depthChartPosition != null) {
    out.depth_chart_position_resolved = ad.depthChartPosition;
  }
  if (ad.ageComponent !== 0) {
    out.age_component = ad.ageComponent;
  }
  if (ad.depthComponent !== 0) {
    out.depth_component = ad.depthComponent;
  }
  return out;
}

/**
 * Ordered baseline risk passes: age/depth chart, then injury. Keeps `baselineValueEngine` readable.
 */
export function applyBaselineRiskChain(params: {
  player: LeanPlayer;
  baselineValue: number;
  isPitcher: boolean;
}): {
  adjustedValue: number;
  ageDepthComponent?: number;
  injuryComponent?: number;
  riskExplain: BaselineRiskExplainFields;
} {
  const ad = applyAgeDepthAdjustment({
    player: params.player,
    baselineValue: params.baselineValue,
    isPitcher: params.isPitcher,
  });
  const inj = applyInjuryAdjustment({
    player: params.player,
    baselineValue: ad.adjustedValue,
  });
  const out: {
    adjustedValue: number;
    ageDepthComponent?: number;
    injuryComponent?: number;
    riskExplain: BaselineRiskExplainFields;
  } = {
    adjustedValue: inj.adjustedValue,
    riskExplain: buildBaselineRiskExplain(params.player, ad, inj),
  };
  if (ad.ageDepthComponent !== 0) {
    out.ageDepthComponent = ad.ageDepthComponent;
  }
  if (inj.injuryComponent !== 0) {
    out.injuryComponent = inj.injuryComponent;
  }
  return out;
}
