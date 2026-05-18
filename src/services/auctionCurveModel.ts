import type { Stage3bPitcherAuctionConfig } from "./stage3bPitcherCalibration";

/**
 * Auction dollar curve on top of replacement_slots_v2 surplus_basis.
 */
export type AuctionCurveModel =
  | "linear_v1"
  | "tiered_surplus_v1"
  | "adaptive_surplus_v1";

export const DEFAULT_AUCTION_CURVE_MODEL: AuctionCurveModel = "adaptive_surplus_v1";

/** Tier fractions of the draftable pool (star + starter + depth = 100% of draftable). */
export const TIERED_SURPLUS_V1 = {
  starFraction: 0.1,
  starterFraction: 0.25,
  starWeight: 2.75,
  starterWeight: 1,
  depthWeight: 0.28,
  fringeWeight: 0.06,
} as const;

export type TierSurplusConfig = {
  starFraction?: number;
  starterFraction?: number;
  starWeight?: number;
  starterWeight?: number;
  depthWeight?: number;
  fringeWeight?: number;
};

export type TieredSurplusTier = "star" | "starter" | "depth" | "fringe" | "none";

export function resolveAuctionCurveModel(
  value: string | undefined | null
): AuctionCurveModel {
  if (value === "tiered_surplus_v1") return "tiered_surplus_v1";
  if (value === "adaptive_surplus_v1") return "adaptive_surplus_v1";
  if (value === "linear_v1") return "linear_v1";
  return DEFAULT_AUCTION_CURVE_MODEL;
}

function tierConfigResolved(config?: TierSurplusConfig) {
  return {
    starFraction: config?.starFraction ?? TIERED_SURPLUS_V1.starFraction,
    starterFraction: config?.starterFraction ?? TIERED_SURPLUS_V1.starterFraction,
    starWeight: config?.starWeight ?? TIERED_SURPLUS_V1.starWeight,
    starterWeight: config?.starterWeight ?? TIERED_SURPLUS_V1.starterWeight,
    depthWeight: config?.depthWeight ?? TIERED_SURPLUS_V1.depthWeight,
    fringeWeight: config?.fringeWeight ?? TIERED_SURPLUS_V1.fringeWeight,
  };
}

/**
 * Allocates `surplusCash` across players with tier-weighted surplus_basis.
 * Returns dollars above min_bid per player_id (not including min_bid).
 */
export function buildTieredSurplusDollars(params: {
  surplusCash: number;
  draftablePlayerIds: readonly string[];
  surplusBasisById: Map<string, number>;
  fringePlayerIds?: readonly string[];
  tierConfig?: TierSurplusConfig;
  /** Saturated-slot hybrid lift → at least starter-tier auction weight. */
  hybridLiftById?: Map<string, number>;
  assignedSlotById?: Map<string, string>;
  pitcherAuction?: Stage3bPitcherAuctionConfig;
}): {
  dollarsByPlayerId: Map<string, number>;
  tierByPlayerId: Map<string, TieredSurplusTier>;
  weightByPlayerId: Map<string, number>;
} {
  const dollarsByPlayerId = new Map<string, number>();
  const tierByPlayerId = new Map<string, TieredSurplusTier>();
  const weightByPlayerId = new Map<string, number>();
  const cfg = tierConfigResolved(params.tierConfig);
  const { surplusCash, draftablePlayerIds, surplusBasisById, fringePlayerIds } =
    params;

  if (surplusCash <= 0) {
    return { dollarsByPlayerId, tierByPlayerId, weightByPlayerId };
  }

  const draftable = draftablePlayerIds
    .map((id) => ({ id, sb: surplusBasisById.get(id) ?? 0 }))
    .filter((r) => r.sb > 0)
    .sort((a, b) => b.sb - a.sb);

  const n = draftable.length;
  const starN = n > 0 ? Math.max(1, Math.ceil(n * cfg.starFraction)) : 0;
  const starterN =
    n > starN ? Math.max(0, Math.ceil(n * cfg.starterFraction)) : 0;
  const depthStart = starN + starterN;

  const weights = new Map<string, number>();

  for (let i = 0; i < draftable.length; i++) {
    const { id, sb } = draftable[i]!;
    let tier: TieredSurplusTier;
    let w: number;
    if (i < starN) {
      tier = "star";
      w = sb * cfg.starWeight;
    } else if (i < depthStart) {
      tier = "starter";
      w = sb * cfg.starterWeight;
    } else {
      tier = "depth";
      w = sb * cfg.depthWeight;
    }
    const hybridLift = params.hybridLiftById?.get(id) ?? 0;
    if (hybridLift > 1e-9 && sb > 0) {
      if (hybridLift >= 10 && (tier === "starter" || tier === "depth")) {
        tier = "star";
        w = sb * cfg.starWeight * 0.94;
      } else if (tier === "depth") {
        tier = "starter";
        w = sb * cfg.starterWeight * 1.15;
      } else if (tier === "starter" && hybridLift >= 6) {
        w = sb * cfg.starWeight * 0.72;
      }
    }
    const pa = params.pitcherAuction;
    if (pa?.enabled && sb >= (pa.minSurplusBasis ?? 6)) {
      const slot = (params.assignedSlotById?.get(id) ?? "").toUpperCase();
      const isSp = slot === "SP" || slot === "P";
      const isRp = slot === "RP";
      if (isSp || isRp) {
        const promoteMin = pa.promoteStarterMinSurplus ?? 10;
        if (tier === "depth" && isSp && sb >= promoteMin) {
          tier = "starter";
          w = sb * cfg.starterWeight;
        }
        if (isSp) w *= pa.spWeightMult ?? 1;
        else if (isRp) w *= pa.rpWeightMult ?? 1;
      }
    }
    tierByPlayerId.set(id, tier);
    weights.set(id, w);
    weightByPlayerId.set(id, w);
  }

  const draftableSet = new Set(draftablePlayerIds);
  for (const id of fringePlayerIds ?? []) {
    if (draftableSet.has(id)) continue;
    const sb = surplusBasisById.get(id) ?? 0;
    if (sb <= 0) continue;
    tierByPlayerId.set(id, "fringe");
    const w = sb * cfg.fringeWeight;
    weights.set(id, w);
    weightByPlayerId.set(id, w);
  }

  let weightSum = 0;
  for (const w of weights.values()) weightSum += w;
  if (weightSum <= 0) {
    return { dollarsByPlayerId, tierByPlayerId, weightByPlayerId };
  }

  for (const [id, w] of weights) {
    dollarsByPlayerId.set(id, (surplusCash * w) / weightSum);
  }

  return { dollarsByPlayerId, tierByPlayerId, weightByPlayerId };
}
