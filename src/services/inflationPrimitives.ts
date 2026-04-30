import type {
  DraftedPlayer,
  InflationBoundedBy,
  LeanPlayer,
} from "../types/brain";

export type SurplusPlan = {
  replacementValue: number;
  poolSurplusSum: number;
  surplusCash: number;
};

export function clampInflation(
  raw: number,
  cap: number | undefined,
  floor: number | undefined
): {
  inflation_raw: number;
  inflation_factor: number;
  inflation_bounded_by: InflationBoundedBy;
} {
  const capV =
    cap != null && Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
  const floorV =
    floor != null && Number.isFinite(floor) && floor > 0 ? floor : 0.25;
  const capped = Math.min(capV, raw);
  const applied = Math.max(floorV, capped);
  const eps = 1e-5;
  let inflation_bounded_by: InflationBoundedBy = "none";
  if (applied > raw + eps) inflation_bounded_by = "floor";
  else if (applied + eps < raw) inflation_bounded_by = "cap";
  return { inflation_raw: raw, inflation_factor: applied, inflation_bounded_by };
}

export function computeBudgetRemaining(params: {
  draftedPlayers: DraftedPlayer[];
  totalBudgetPerTeam: number;
  numTeams: number;
  budgetByTeamId?: Record<string, number>;
  additionalSpent?: number;
}): number {
  const {
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId,
    additionalSpent,
  } = params;
  if (budgetByTeamId && Object.keys(budgetByTeamId).length > 0) {
    return Object.values(budgetByTeamId).reduce((sum, v) => sum + v, 0);
  }
  const totalLeagueBudget = totalBudgetPerTeam * numTeams;
  const budgetSpent = draftedPlayers.reduce((sum, dp) => sum + (dp.paid ?? 0), 0);
  return Math.max(0, totalLeagueBudget - budgetSpent - (additionalSpent ?? 0));
}

export function tryBuildSurplusPlan(params: {
  byValueFull: LeanPlayer[];
  undraftedCount: number;
  remainingSlots: number;
  budgetRemaining: number;
  minAuctionBid: number;
  surplusDraftablePoolMultiplier: number;
}): SurplusPlan | null {
  const {
    byValueFull,
    undraftedCount,
    remainingSlots,
    budgetRemaining,
    minAuctionBid,
    surplusDraftablePoolMultiplier,
  } = params;
  if (remainingSlots <= 0 || undraftedCount === 0) return null;
  const k = Math.min(
    undraftedCount,
    Math.ceil(remainingSlots * surplusDraftablePoolMultiplier)
  );
  if (k < 1) return null;
  const draftable = byValueFull.slice(0, k);
  const replacementValue = draftable[draftable.length - 1]?.value ?? 0;
  let poolSurplusSum = 0;
  for (const p of draftable) {
    poolSurplusSum += Math.max(0, (p.value || 0) - replacementValue);
  }
  if (poolSurplusSum <= 0) return null;
  const surplusCash = Math.max(0, budgetRemaining - remainingSlots * minAuctionBid);
  return { replacementValue, poolSurplusSum, surplusCash };
}
