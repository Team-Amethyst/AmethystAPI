import type { LeanPlayer } from "../types/brain";
import { applyAgeDepthAdjustment } from "./baselineAgeDepthAdjustments";
import { applyInjuryAdjustment } from "./baselineInjuryAdjustments";

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
  } = { adjustedValue: inj.adjustedValue };
  if (ad.ageDepthComponent !== 0) {
    out.ageDepthComponent = ad.ageDepthComponent;
  }
  if (inj.injuryComponent !== 0) {
    out.injuryComponent = inj.injuryComponent;
  }
  return out;
}
