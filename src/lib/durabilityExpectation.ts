import type { LeanPlayer } from "../types/brain";
import type {
  DurabilityExpectation,
  DurabilityExpectationReason,
} from "../types/durabilityExpectation";
import {
  isHitter,
  playerTokensFromLean,
  type PositionOverrideMap,
} from "./fantasyRosterSlots";
import {
  isPitcherForBaseline,
  isTwoWayEligibleForBaseline,
} from "../services/baselineProjectionStats";

export type { DurabilityExpectation, DurabilityExpectationReason } from "../types/durabilityExpectation";

export type DurabilityExpectationResult = {
  durability_expectation: DurabilityExpectation;
  durability_expectation_reasons: DurabilityExpectationReason[];
};

export type ClassifyDurabilityExpectationOptions = {
  positionOverrides?: PositionOverrideMap;
  /** When present (from `projection.__valuation_meta__.two_way_role_selected`), aligns with baseline role. */
  twoWayRoleSelected?: "hitter" | "pitcher";
};

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function projPa(lp: LeanPlayer): number {
  const bat = (lp.projection as Record<string, unknown> | undefined)?.batting as
    | Record<string, unknown>
    | undefined;
  return bat ? toNum(bat.plateAppearances) : 0;
}

function projIp(lp: LeanPlayer): number {
  const pit = (lp.projection as Record<string, unknown> | undefined)?.pitching as
    | Record<string, unknown>
    | undefined;
  if (!pit) return 0;
  const v =
    pit.innings ?? (pit as Record<string, unknown>).inningsPitched ?? (pit as Record<string, unknown>).ip;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function prospectUncertain(params: {
  age: number | null | undefined;
  catalog_tier: number | null | undefined;
  catalog_rank: number | null | undefined;
}): boolean {
  const age = params.age;
  const tier = params.catalog_tier;
  const rank = params.catalog_rank;
  if (age != null && age <= 23) return true;
  if (tier != null && tier >= 5) return true;
  if (rank != null && rank > 450) return true;
  return false;
}

function platoonOrPartTime(
  depthChartPosition: number | null | undefined,
  market_adp: number | null | undefined
): boolean {
  if (depthChartPosition !== 2) return false;
  if (market_adp == null) return false;
  return market_adp >= 42;
}

function usePitcherDurabilityBranch(
  lp: LeanPlayer,
  overrides: PositionOverrideMap | undefined,
  twoWayRoleSelected: ClassifyDurabilityExpectationOptions["twoWayRoleSelected"]
): boolean {
  const tokens = playerTokensFromLean(lp, overrides);
  const pitcherOnly = isPitcherForBaseline(lp, overrides) && !isHitter(tokens);
  if (pitcherOnly) return true;
  if (isTwoWayEligibleForBaseline(lp, overrides) && twoWayRoleSelected === "pitcher") return true;
  return false;
}

function pitcherClassify(lp: LeanPlayer, inj: number | null | undefined): DurabilityExpectationResult {
  const reasons: DurabilityExpectationReason[] = [];
  if (inj != null && inj > 0) {
    reasons.push("active injury severity");
    return { durability_expectation: "limited_role_expected", durability_expectation_reasons: reasons };
  }
  const ip = projIp(lp);
  if (ip >= 130) {
    reasons.push("full workload projection");
    return { durability_expectation: "full_role_expected", durability_expectation_reasons: reasons };
  }
  if (ip > 0 && ip < 130) {
    reasons.push("low projected PA");
    return { durability_expectation: "limited_role_expected", durability_expectation_reasons: reasons };
  }
  return { durability_expectation: "unknown", durability_expectation_reasons: [] };
}

/**
 * Classifies expected durability / playing-time posture for audit and explain payloads.
 * Uses `market_adp` and `catalog_rank` only as **gates** (never as dollar inputs elsewhere).
 */
export function classifyDurabilityExpectation(
  lp: LeanPlayer,
  options?: ClassifyDurabilityExpectationOptions
): DurabilityExpectationResult {
  const ov = options?.positionOverrides;
  const tw = options?.twoWayRoleSelected;
  const inj = lp.injurySeverity ?? null;
  const marketAdp = lp.market_adp ?? null;
  const rank = lp.catalog_rank ?? null;
  const tier = lp.catalog_tier ?? null;
  const age = lp.age ?? null;
  const dc = lp.depthChartPosition ?? null;

  if (usePitcherDurabilityBranch(lp, ov, tw)) {
    return pitcherClassify(lp, inj);
  }

  const reasons: DurabilityExpectationReason[] = [];

  if (inj != null && inj > 0) {
    reasons.push("active injury severity");
    return { durability_expectation: "limited_role_expected", durability_expectation_reasons: [...reasons] };
  }

  if (prospectUncertain({ age, catalog_tier: tier, catalog_rank: rank })) {
    reasons.push("age/prospect profile");
    return { durability_expectation: "prospect_uncertain", durability_expectation_reasons: reasons };
  }

  if (platoonOrPartTime(dc, marketAdp)) {
    reasons.push("depth chart position");
    reasons.push("high market ADP vs model");
    return { durability_expectation: "platoon_or_part_time", durability_expectation_reasons: reasons };
  }

  const pa = projPa(lp);
  if (pa >= 500) {
    reasons.push("full workload projection");
    return { durability_expectation: "full_role_expected", durability_expectation_reasons: reasons };
  }

  if (pa <= 0) {
    return { durability_expectation: "unknown", durability_expectation_reasons: [] };
  }

  /** Cautious band: late ADP with suppressed PA — chronic PT risk without richer IL history. */
  if (marketAdp != null && marketAdp > 55) {
    reasons.push("low projected PA");
    reasons.push("high market ADP vs model");
    return { durability_expectation: "limited_role_expected", durability_expectation_reasons: reasons };
  }

  const recoveryCohort =
    marketAdp != null &&
    marketAdp <= 75 &&
    pa < 500 &&
    (inj == null || inj === 0) &&
    (marketAdp <= 45 || (rank != null && rank <= 400));

  if (recoveryCohort) {
    reasons.push("low projected PA");
    reasons.push("high market ADP vs model");
    return { durability_expectation: "recovery_upside", durability_expectation_reasons: reasons };
  }

  if (pa < 500) {
    reasons.push("low projected PA");
    return { durability_expectation: "limited_role_expected", durability_expectation_reasons: reasons };
  }

  return { durability_expectation: "unknown", durability_expectation_reasons: [] };
}
