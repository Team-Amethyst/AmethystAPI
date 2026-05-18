import type { LeagueBoardPhase, SurplusAllocationMode } from "./auctionCurveResolver";

export type SurplusSmoothingConfig = {
  /** Fraction of tiered dollars kept after linear blend (0–1). */
  tieredFraction: number;
  maxDropAbs: number;
  maxDropPct: number;
  /** Top N players by surplus_basis rank to enforce adjacent-drop caps. */
  smoothRankCount: number;
  maxIterations: number;
};

function sumMapValues(map: Map<string, number>): number {
  let sum = 0;
  for (const v of map.values()) sum += v;
  return sum;
}

/** Proportional surplus allocation by surplus_basis (linear_v1 dollars). */
export function buildLinearSurplusDollars(params: {
  surplusCash: number;
  draftablePlayerIds: readonly string[];
  surplusBasisById: Map<string, number>;
}): Map<string, number> {
  const out = new Map<string, number>();
  const { surplusCash, draftablePlayerIds, surplusBasisById } = params;
  if (surplusCash <= 0) return out;

  let weightSum = 0;
  const weights = new Map<string, number>();
  for (const id of draftablePlayerIds) {
    const sb = surplusBasisById.get(id) ?? 0;
    if (sb <= 0) continue;
    weights.set(id, sb);
    weightSum += sb;
  }
  if (weightSum <= 0) return out;

  for (const [id, w] of weights) {
    out.set(id, (surplusCash * w) / weightSum);
  }
  return out;
}

export function blendSurplusDollarMaps(
  tiered: Map<string, number>,
  linear: Map<string, number>,
  tieredFraction: number
): Map<string, number> {
  const alpha = Math.max(0, Math.min(1, tieredFraction));
  const ids = new Set([...tiered.keys(), ...linear.keys()]);
  const out = new Map<string, number>();
  for (const id of ids) {
    const t = tiered.get(id) ?? 0;
    const l = linear.get(id) ?? 0;
    out.set(id, alpha * t + (1 - alpha) * l);
  }
  return out;
}

export function normalizeSurplusMap(
  map: Map<string, number>,
  surplusCash: number
): Map<string, number> {
  const sum = sumMapValues(map);
  if (sum <= 0 || surplusCash <= 0) return new Map(map);
  const scale = surplusCash / sum;
  const out = new Map<string, number>();
  for (const [id, v] of map) out.set(id, v * scale);
  return out;
}

/**
 * Limits surplus drops between adjacent surplus_basis ranks, then re-normalizes
 * to conserve `surplusCash`. Iterates so scaling does not re-open cliffs.
 */
export function smoothSurplusAlongBasisRank(params: {
  dollarsByPlayerId: Map<string, number>;
  surplusCash: number;
  draftablePlayerIds: readonly string[];
  surplusBasisById: Map<string, number>;
  config: SurplusSmoothingConfig;
}): { dollarsByPlayerId: Map<string, number>; applied: string[] } {
  const applied: string[] = [];
  const { surplusCash, surplusBasisById, config } = params;

  const ranked = params.draftablePlayerIds
    .map((id) => ({ id, sb: surplusBasisById.get(id) ?? 0 }))
    .filter((r) => r.sb > 0)
    .sort((a, b) => b.sb - a.sb)
    .slice(0, config.smoothRankCount)
    .map((r) => r.id);

  if (ranked.length < 2 || surplusCash <= 0) {
    return { dollarsByPlayerId: new Map(params.dollarsByPlayerId), applied };
  }

  let map = new Map(params.dollarsByPlayerId);

  for (let iter = 0; iter < config.maxIterations; iter++) {
    let changed = false;
    for (let i = 0; i < ranked.length - 1; i++) {
      const hiId = ranked[i]!;
      const loId = ranked[i + 1]!;
      const hi = map.get(hiId) ?? 0;
      const lo = map.get(loId) ?? 0;
      const maxDrop = Math.max(config.maxDropAbs, config.maxDropPct * hi);
      const floor = Math.max(0, hi - maxDrop);
      if (lo < floor - 1e-9) {
        map.set(loId, floor);
        changed = true;
      }
    }
    const normalized = normalizeSurplusMap(map, surplusCash);
    map = normalized;
    if (changed) {
      applied.push(`basis_rank_adjacent_cap_iter_${iter + 1}`);
    } else {
      break;
    }
  }

  return { dollarsByPlayerId: map, applied };
}

export function resolveSurplusSmoothingConfig(
  internalMode: SurplusAllocationMode,
  phase: LeagueBoardPhase,
  remainingActiveSlots?: number,
): SurplusSmoothingConfig | null {
  if (internalMode === "linear") return null;

  const manySlotsOpen =
    remainingActiveSlots != null && remainingActiveSlots >= 70;

  if (internalMode === "tiered_soft") {
    if (phase === "mid_draft") {
      return {
        tieredFraction: manySlotsOpen ? 0.78 : 0.52,
        maxDropAbs: manySlotsOpen ? 3.5 : 2.75,
        maxDropPct: manySlotsOpen ? 0.2 : 0.17,
        smoothRankCount: 160,
        maxIterations: 4,
      };
    }
    if (phase === "late_draft") {
      return {
        tieredFraction: manySlotsOpen ? 0.84 : 0.62,
        maxDropAbs: manySlotsOpen ? 4 : 2.35,
        maxDropPct: manySlotsOpen ? 0.22 : 0.14,
        smoothRankCount: 130,
        maxIterations: 3,
      };
    }
    return {
      tieredFraction: 0.7,
      maxDropAbs: 3,
      maxDropPct: 0.2,
      smoothRankCount: 120,
      maxIterations: 3,
    };
  }

  // tiered_keeper: preserve star spread; only soften tier-boundary cliffs.
  return {
    tieredFraction: 0.88,
    maxDropAbs: 4.25,
    maxDropPct: 0.26,
    smoothRankCount: 95,
    maxIterations: 2,
  };
}

export function applyTieredSurplusSmoothing(params: {
  tieredDollars: Map<string, number>;
  surplusCash: number;
  draftablePlayerIds: readonly string[];
  surplusBasisById: Map<string, number>;
  internalMode: SurplusAllocationMode;
  phase: LeagueBoardPhase;
  remainingActiveSlots?: number;
}): { dollarsByPlayerId: Map<string, number>; applied: string[] } {
  const config = resolveSurplusSmoothingConfig(
    params.internalMode,
    params.phase,
    params.remainingActiveSlots,
  );
  if (!config) {
    return { dollarsByPlayerId: new Map(params.tieredDollars), applied: [] };
  }

  const applied: string[] = [
    `tiered_linear_blend_${params.internalMode}_${params.phase}`,
  ];

  const linear = buildLinearSurplusDollars({
    surplusCash: params.surplusCash,
    draftablePlayerIds: params.draftablePlayerIds,
    surplusBasisById: params.surplusBasisById,
  });

  const blended = blendSurplusDollarMaps(
    params.tieredDollars,
    linear,
    config.tieredFraction
  );
  const normalizedBlend = normalizeSurplusMap(blended, params.surplusCash);

  const smoothed = smoothSurplusAlongBasisRank({
    dollarsByPlayerId: normalizedBlend,
    surplusCash: params.surplusCash,
    draftablePlayerIds: params.draftablePlayerIds,
    surplusBasisById: params.surplusBasisById,
    config,
  });

  applied.push(...smoothed.applied);

  return {
    dollarsByPlayerId: smoothed.dollarsByPlayerId,
    applied,
  };
}
