import type { LeanPlayer } from "../types/brain";

/**
 * Tunable priors for baseline valuation:
 * - Age curve: keeps effect modest and symmetric.
 * - Depth chart: explicit slot (1=starter, 2=platoon/setup, 3+=bench/long relief).
 */
export const AGE_DEPTH_TUNING = {
  age: {
    hitter_peak_low: 25,
    hitter_peak_high: 29,
    pitcher_peak_low: 26,
    pitcher_peak_high: 31,
    hitter_young_penalty_per_year: 0.012,
    hitter_old_penalty_per_year: 0.01,
    pitcher_young_penalty_per_year: 0.008,
    pitcher_old_penalty_per_year: 0.012,
    floor: 0.88,
    cap: 1.04,
  },
  depth: {
    starter_mult: 1.06,
    second_mult: 1.0,
    third_mult: 0.92,
    reserve_mult: 0.84,
  },
  combined: {
    floor: 0.8,
    cap: 1.14,
  },
} as const;

function toFinite(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function resolveDepthChartPosition(p: LeanPlayer): number | undefined {
  const direct = toFinite(p.depthChartPosition);
  if (direct != null && direct > 0) return Math.trunc(direct);

  const proj = p.projection as Record<string, unknown> | undefined;
  const fromProj =
    toFinite(proj?.depth_chart_position) ??
    toFinite(proj?.depthChartPosition) ??
    toFinite(proj?.depth_chart_rank) ??
    toFinite(proj?.depthChartRank);
  if (fromProj != null && fromProj > 0) return Math.trunc(fromProj);

  // Fallback proxy when no explicit depth data exists.
  if ((p.tier ?? 99) <= 1) return 1;
  if ((p.tier ?? 99) <= 3) return 2;
  return 3;
}

export function ageMultiplier(age: number | undefined, isPitcher: boolean): number {
  if (age == null || !Number.isFinite(age) || age <= 0) return 1;
  const t = AGE_DEPTH_TUNING.age;
  const peakLow = isPitcher ? t.pitcher_peak_low : t.hitter_peak_low;
  const peakHigh = isPitcher ? t.pitcher_peak_high : t.hitter_peak_high;
  const youngPenalty = isPitcher
    ? t.pitcher_young_penalty_per_year
    : t.hitter_young_penalty_per_year;
  const oldPenalty = isPitcher
    ? t.pitcher_old_penalty_per_year
    : t.hitter_old_penalty_per_year;
  if (age < peakLow) {
    return Math.max(t.floor, 1 - (peakLow - age) * youngPenalty);
  }
  if (age > peakHigh) {
    return Math.max(t.floor, 1 - (age - peakHigh) * oldPenalty);
  }
  return t.cap;
}

export function depthChartMultiplier(depthPos: number | undefined): number {
  if (depthPos == null || !Number.isFinite(depthPos) || depthPos <= 0) return 1;
  if (depthPos <= 1) return AGE_DEPTH_TUNING.depth.starter_mult;
  if (depthPos === 2) return AGE_DEPTH_TUNING.depth.second_mult;
  if (depthPos === 3) return AGE_DEPTH_TUNING.depth.third_mult;
  return AGE_DEPTH_TUNING.depth.reserve_mult;
}

export function applyAgeDepthAdjustment(params: {
  player: LeanPlayer;
  baselineValue: number;
  isPitcher: boolean;
}): {
  adjustedValue: number;
  ageDepthComponent: number;
  ageMultiplier: number;
  depthMultiplier: number;
  depthChartPosition?: number;
} {
  const { player, baselineValue, isPitcher } = params;
  const ageMult = ageMultiplier(player.age, isPitcher);
  const depthPos = resolveDepthChartPosition(player);
  const depthMult = depthChartMultiplier(depthPos);
  const combinedRaw = ageMult * depthMult;
  const combined = Math.min(
    AGE_DEPTH_TUNING.combined.cap,
    Math.max(AGE_DEPTH_TUNING.combined.floor, combinedRaw)
  );
  const adjustedValue = Math.max(1, baselineValue * combined);
  return {
    adjustedValue,
    ageDepthComponent: Number((adjustedValue - baselineValue).toFixed(2)),
    ageMultiplier: Number(ageMult.toFixed(4)),
    depthMultiplier: Number(depthMult.toFixed(4)),
    ...(depthPos != null ? { depthChartPosition: depthPos } : {}),
  };
}
