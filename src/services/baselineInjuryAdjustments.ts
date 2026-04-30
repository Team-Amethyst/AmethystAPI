import type { LeanPlayer } from "../types/brain";

/** 0 = healthy / unknown; higher = larger baseline haircut (IL, long-term). */
export const INJURY_TUNING = {
  multipliers: {
    0: 1,
    1: 0.985,
    2: 0.92,
    3: 0.78,
  } as const,
  floor: 0.72,
  cap: 1,
} as const;

export function resolveInjurySeverity(p: LeanPlayer): number {
  const raw = p.injurySeverity;
  if (raw == null || !Number.isFinite(raw)) return 0;
  return Math.min(3, Math.max(0, Math.trunc(raw)));
}

export function injuryMultiplier(severity: number): number {
  const s = Math.min(3, Math.max(0, severity)) as 0 | 1 | 2 | 3;
  const m = INJURY_TUNING.multipliers[s];
  return Math.min(INJURY_TUNING.cap, Math.max(INJURY_TUNING.floor, m));
}

export function applyInjuryAdjustment(params: {
  player: LeanPlayer;
  baselineValue: number;
}): { adjustedValue: number; injuryComponent: number } {
  const sev = resolveInjurySeverity(params.player);
  if (sev <= 0) {
    return { adjustedValue: params.baselineValue, injuryComponent: 0 };
  }
  const mult = injuryMultiplier(sev);
  const adjustedValue = Math.max(1, params.baselineValue * mult);
  return {
    adjustedValue,
    injuryComponent: Number((adjustedValue - params.baselineValue).toFixed(2)),
  };
}
