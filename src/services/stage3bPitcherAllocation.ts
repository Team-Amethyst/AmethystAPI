import {
  buildTieredSurplusDollars,
  type TierSurplusConfig,
  type TieredSurplusTier,
} from "./auctionCurveModel";
import type {
  Stage3bPitcherAuctionConfig,
  Stage3bPitcherRelativeBudgetConfig,
} from "./stage3bPitcherCalibration";

function isPitcherSlot(slot: string): boolean {
  const u = slot.toUpperCase();
  return u === "SP" || u === "RP" || u === "P";
}

function isSpSlot(slot: string): boolean {
  const u = slot.toUpperCase();
  return u === "SP" || u === "P";
}

export type PitcherRoleSlot = "SP" | "RP" | "P";

/**
 * Greedy slot fill can assign hitters slots to two-way or P-eligible arms;
 * auction SP floors use token/position role when surplus supports SP.
 */
export function resolvePitcherRoleSlot(params: {
  assignedSlot?: string | null;
  tokens?: readonly string[];
  position?: string;
}): PitcherRoleSlot | "" {
  const greedy = (params.assignedSlot ?? "").trim().toUpperCase();
  const toks = (params.tokens ?? []).map((t) => t.trim().toUpperCase());
  const spEligible = toks.includes("SP") || toks.includes("P");
  if (greedy === "SP" || greedy === "RP" || greedy === "P") {
    // Greedy fill may park SP arms in RP when RP slots are scarce; auction uses SP path when eligible.
    if (greedy === "RP" && spEligible) return "SP";
    return greedy;
  }
  if (toks.includes("SP")) return "SP";
  if (toks.includes("RP")) return "RP";
  if (toks.includes("P")) return "P";
  const pos = (params.position ?? "").trim().toUpperCase();
  if (pos === "SP" || pos === "RP") return pos;
  if (pos === "P") return "P";
  return "";
}

export function buildPitcherAuctionSlotById(params: {
  playerIds: readonly string[];
  assignedSlotById?: Map<string, string>;
  tokensById?: Map<string, readonly string[]>;
  positionById?: Map<string, string>;
}): Map<string, string> {
  const merged = new Map<string, string>();
  for (const id of params.playerIds) {
    const role = resolvePitcherRoleSlot({
      assignedSlot: params.assignedSlotById?.get(id),
      tokens: params.tokensById?.get(id),
      position: params.positionById?.get(id),
    });
    if (role) merged.set(id, role);
    else {
      const g = params.assignedSlotById?.get(id);
      if (g) merged.set(id, g);
    }
  }
  return merged;
}

const DEFAULT_PITCHER_TIER: TierSurplusConfig = {
  starFraction: 0.14,
  starterFraction: 0.38,
  starWeight: 2.35,
  starterWeight: 1.08,
  depthWeight: 0.52,
};

/**
 * Optional dual-bucket tiering (matrix experiments). Production uses global tiering
 * plus targeted SP floors instead.
 */
export function buildBucketTieredSurplusDollars(params: {
  surplusCash: number;
  draftablePlayerIds: readonly string[];
  surplusBasisById: Map<string, number>;
  fringePlayerIds?: readonly string[];
  hitterTierConfig?: TierSurplusConfig;
  pitcherRelative: Stage3bPitcherRelativeBudgetConfig;
  hybridLiftById?: Map<string, number>;
  assignedSlotById?: Map<string, string>;
  pitcherAuction?: Stage3bPitcherAuctionConfig;
}): {
  dollarsByPlayerId: Map<string, number>;
  tierByPlayerId: Map<string, TieredSurplusTier>;
  weightByPlayerId: Map<string, number>;
} {
  const {
    surplusCash,
    draftablePlayerIds,
    surplusBasisById,
    assignedSlotById,
    pitcherRelative: pr,
  } = params;

  const pitcherIds: string[] = [];
  const hitterIds: string[] = [];
  const minSb = pr.minPitcherSurplusBasis ?? 4;

  for (const id of draftablePlayerIds) {
    const sb = surplusBasisById.get(id) ?? 0;
    if (sb <= 0) continue;
    const slot = assignedSlotById?.get(id) ?? "";
    if (isPitcherSlot(slot) && sb >= minSb) pitcherIds.push(id);
    else hitterIds.push(id);
  }

  const share = Math.max(0.12, Math.min(0.38, pr.pitcherSurplusShare ?? 0.27));
  let pitcherCash = pitcherIds.length > 0 ? surplusCash * share : 0;
  let hitterCash = surplusCash - pitcherCash;
  if (hitterIds.length === 0) {
    pitcherCash = surplusCash;
    hitterCash = 0;
  } else if (pitcherIds.length === 0) {
    hitterCash = surplusCash;
    pitcherCash = 0;
  }

  const pitcherTier: TierSurplusConfig = {
    ...DEFAULT_PITCHER_TIER,
    starFraction: pr.pitcherStarFraction ?? DEFAULT_PITCHER_TIER.starFraction,
    starterFraction:
      pr.pitcherStarterFraction ?? DEFAULT_PITCHER_TIER.starterFraction,
    starWeight: pr.pitcherStarWeight ?? DEFAULT_PITCHER_TIER.starWeight,
    starterWeight: pr.pitcherStarterWeight ?? DEFAULT_PITCHER_TIER.starterWeight,
    depthWeight: pr.pitcherDepthWeight ?? DEFAULT_PITCHER_TIER.depthWeight,
  };

  const dollarsByPlayerId = new Map<string, number>();
  const tierByPlayerId = new Map<string, TieredSurplusTier>();
  const weightByPlayerId = new Map<string, number>();

  if (hitterCash > 0 && hitterIds.length > 0) {
    const h = buildTieredSurplusDollars({
      surplusCash: hitterCash,
      draftablePlayerIds: hitterIds,
      surplusBasisById,
      tierConfig: params.hitterTierConfig,
      hybridLiftById: params.hybridLiftById,
      assignedSlotById,
    });
    for (const [id, v] of h.dollarsByPlayerId) dollarsByPlayerId.set(id, v);
    for (const [id, v] of h.tierByPlayerId) tierByPlayerId.set(id, v);
    for (const [id, v] of h.weightByPlayerId) weightByPlayerId.set(id, v);
  }

  if (pitcherCash > 0 && pitcherIds.length > 0) {
    const p = buildTieredSurplusDollars({
      surplusCash: pitcherCash,
      draftablePlayerIds: pitcherIds,
      surplusBasisById,
      tierConfig: pitcherTier,
      hybridLiftById: params.hybridLiftById,
      assignedSlotById,
      pitcherAuction: params.pitcherAuction,
    });
    for (const [id, v] of p.dollarsByPlayerId) dollarsByPlayerId.set(id, v);
    for (const [id, v] of p.tierByPlayerId) tierByPlayerId.set(id, v);
    for (const [id, v] of p.weightByPlayerId) weightByPlayerId.set(id, v);
  }

  const draftableSet = new Set(draftablePlayerIds);
  for (const id of params.fringePlayerIds ?? []) {
    if (draftableSet.has(id)) continue;
    const sb = surplusBasisById.get(id) ?? 0;
    if (sb <= 0) continue;
    tierByPlayerId.set(id, "fringe");
  }

  return { dollarsByPlayerId, tierByPlayerId, weightByPlayerId };
}

/**
 * Targeted SP surplus-dollar floors for marginal starters (Woo/Ryan class), funded
 * by proportional trim from depth-tier draftable players — conserves total surplus_cash.
 */
export function applyTargetedSpSurplusFloors(params: {
  dollarsByPlayerId: Map<string, number>;
  tierByPlayerId: Map<string, TieredSurplusTier>;
  surplusCash: number;
  draftablePlayerIds: readonly string[];
  surplusBasisById: Map<string, number>;
  assignedSlotById?: Map<string, string>;
  tokensById?: Map<string, readonly string[]>;
  positionById?: Map<string, string>;
  pitcherAuction?: Stage3bPitcherAuctionConfig;
}): void {
  const pa = params.pitcherAuction;
  if (!pa?.enabled) return;

  const dollarPerSb = pa.spSurplusDollarPerSb;
  if (dollarPerSb == null || dollarPerSb <= 0) return;

  const minSb = pa.minSurplusBasis ?? 5;
  const maxSbCap = 24;

  const boosts = new Map<string, number>();
  let boostSum = 0;

  for (const id of params.draftablePlayerIds) {
    const role = resolvePitcherRoleSlot({
      assignedSlot: params.assignedSlotById?.get(id),
      tokens: params.tokensById?.get(id),
      position: params.positionById?.get(id),
    });
    if (!isSpSlot(role)) continue;
    const sb = params.surplusBasisById.get(id) ?? 0;
    if (sb < minSb || sb > maxSbCap) continue;
    const tier = params.tierByPlayerId.get(id);
    if (tier === "star" && sb >= 28) continue;
    const floor = sb * dollarPerSb;
    const cur = params.dollarsByPlayerId.get(id) ?? 0;
    if (floor > cur + 1e-9) {
      boosts.set(id, floor);
      boostSum += floor - cur;
    }
  }
  if (boostSum <= 1e-6) return;

  const donors: { id: string; dollars: number }[] = [];
  let donorSum = 0;
  for (const id of params.draftablePlayerIds) {
    const d = params.dollarsByPlayerId.get(id) ?? 0;
    if (d <= 1e-9) continue;
    if (boosts.has(id)) continue;
    const tier = params.tierByPlayerId.get(id) ?? "depth";
    const sb = params.surplusBasisById.get(id) ?? 0;
    const role = resolvePitcherRoleSlot({
      assignedSlot: params.assignedSlotById?.get(id),
      tokens: params.tokensById?.get(id),
      position: params.positionById?.get(id),
    });
    if (tier === "star" && sb >= 28) continue;
    if (isSpSlot(role) && sb >= 22) continue;
    donors.push({ id, dollars: d });
    donorSum += d;
  }
  let fundable = boostSum;
  if (fundable > donorSum * 0.98) fundable = donorSum * 0.98;
  if (fundable <= 1e-6) return;

  const scale = fundable / boostSum;
  const keepRatio = (donorSum - fundable) / donorSum;
  for (const { id, dollars } of donors) {
    params.dollarsByPlayerId.set(id, dollars * keepRatio);
  }
  for (const [id, targetFloor] of boosts) {
    const cur = params.dollarsByPlayerId.get(id) ?? 0;
    const lift = (targetFloor - cur) * scale;
    params.dollarsByPlayerId.set(id, cur + lift);
  }
}
