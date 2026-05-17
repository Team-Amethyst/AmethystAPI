import type {
  CalculateInflationOptions,
  InflationModel,
  LeanPlayer,
  ValueIndicator,
  ValuedPlayer,
} from "../types/brain";
import type { ScoringFormat } from "../types/core";
import { getPlayerId } from "../lib/playerId";
import type { BaselineRiskExplainFields } from "../types/baselineRiskExplain";
import { pickBaselineRiskExplainFromMeta } from "../types/baselineRiskExplain";
import type { ReplacementSlotsV2Result } from "./replacementSlotsV2";
import type { AuctionCurveModel } from "./auctionCurveModel";
import { valuedPlayerMarketFieldsFromLean } from "../lib/marketAdp/wire";

const STEAL_SLOPE = 1.25;
const REACH_SLOPE = 0.75;

function hash32(seed: number, s: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i);
    h >>>= 0;
  }
  return h >>> 0;
}

export function compareByValueDesc(
  a: LeanPlayer,
  b: LeanPlayer,
  options?: CalculateInflationOptions
): number {
  const diff = (b.value || 0) - (a.value || 0);
  if (diff !== 0) return diff;
  if (options?.deterministic && options.seed != null && Number.isFinite(options.seed)) {
    return (
      hash32(options.seed, getPlayerId(a)) - hash32(options.seed, getPlayerId(b))
    );
  }
  return getPlayerId(a).localeCompare(getPlayerId(b));
}

/** Sort by internal catalog rank (lower = stronger). Not market ADP. */
export function compareByCatalogRankAsc(
  a: LeanPlayer,
  b: LeanPlayer,
  options?: CalculateInflationOptions
): number {
  const diff = (a.catalog_rank || 9999) - (b.catalog_rank || 9999);
  if (diff !== 0) return diff;
  if (options?.deterministic && options.seed != null && Number.isFinite(options.seed)) {
    return (
      hash32(options.seed, getPlayerId(a)) - hash32(options.seed, getPlayerId(b))
    );
  }
  return getPlayerId(a).localeCompare(getPlayerId(b));
}

export function buildValuedRows(params: {
  byValueRows: LeanPlayer[];
  inflationModelEffective: InflationModel;
  v2Result: ReplacementSlotsV2Result | null;
  replacementValue: number;
  inflationFactor: number;
  minAuctionBid: number;
  auctionCurveModel?: AuctionCurveModel;
  baselineOrderRank: Map<string, number>;
  catalogOrderRank: Map<string, number>;
  undraftedCount: number;
}): ValuedPlayer[] {
  const {
    byValueRows,
    inflationModelEffective,
    v2Result,
    replacementValue,
    inflationFactor,
    minAuctionBid,
    auctionCurveModel = "linear_v1",
    baselineOrderRank,
    catalogOrderRank,
    undraftedCount,
  } = params;
  const tieredSurplus =
    v2Result?.playerIdToSurplusDollars != null &&
    (auctionCurveModel === "tiered_surplus_v1" ||
      auctionCurveModel === "adaptive_surplus_v1");
  return byValueRows.map((p) => {
    const pid = getPlayerId(p);
    const baselineValue = p.value || 0;
    let adjustedValue: number;
    if (inflationModelEffective === "replacement_slots_v2" && v2Result) {
      const sb = v2Result.playerIdToSurplusBasis.get(pid) ?? 0;
      if (v2Result.baselineOnly) {
        adjustedValue = parseFloat(baselineValue.toFixed(2));
      } else if (
        v2Result.fallback_reason === "no_surplus_mass" &&
        v2Result.surplus_cash > 0
      ) {
        adjustedValue = parseFloat(Math.max(minAuctionBid, baselineValue).toFixed(2));
      } else if (tieredSurplus) {
        const surplusDollars = v2Result.playerIdToSurplusDollars!.get(pid) ?? 0;
        adjustedValue = parseFloat((minAuctionBid + surplusDollars).toFixed(2));
      } else {
        const draftableIds = v2Result.draftablePlayerIds;
        const inDraftable =
          draftableIds.length === 0 || draftableIds.includes(pid);
        const allocSb = inDraftable ? sb : 0;
        adjustedValue = parseFloat(
          (minAuctionBid + inflationFactor * allocSb).toFixed(2)
        );
      }
    } else if (inflationModelEffective === "surplus_slots_v1") {
      adjustedValue = parseFloat(
        (
          minAuctionBid +
          inflationFactor * Math.max(0, baselineValue - replacementValue)
        ).toFixed(2)
      );
    } else {
      adjustedValue = parseFloat((baselineValue * inflationFactor).toFixed(2));
    }

    const meta = (
      p.projection as { __valuation_meta__?: Record<string, unknown> } | undefined
    )?.__valuation_meta__;

    let indicator: ValueIndicator = "Fair Value";
    if (undraftedCount > 0) {
      const vRank = baselineOrderRank.get(pid) ?? 0;
      const cRank = catalogOrderRank.get(pid) ?? 0;
      if (cRank > vRank * STEAL_SLOPE) indicator = "Steal";
      else if (cRank < vRank * REACH_SLOPE) indicator = "Reach";
    }

    const adjustedRounded = parseFloat(adjustedValue.toFixed(2));
    const scoringFormatFromMeta = (): ScoringFormat | "default" => {
      const s = meta?.scoring_format;
      if (s === "5x5" || s === "6x6" || s === "points") return s;
      return "default";
    };
    const riskDefaults: BaselineRiskExplainFields = {
      age_multiplier: 1,
      depth_multiplier: 1,
      age_depth_combined_multiplier: 1,
      injury_severity: 0,
      injury_multiplier: 1,
    };
    const riskExplain: BaselineRiskExplainFields = {
      ...riskDefaults,
      ...(meta ? pickBaselineRiskExplainFromMeta(meta as Record<string, unknown>) : {}),
    };
    return {
      player_id: pid,
      name: p.name,
      position: p.position,
      team: p.team,
      catalog_rank: p.catalog_rank || 0,
      catalog_tier: p.catalog_tier || 0,
      baseline_rank: 0,
      auction_rank: 0,
      baseline_tier: 1,
      auction_tier: 1,
      baseline_value: baselineValue,
      auction_value: adjustedRounded,
      adjusted_value: adjustedRounded,
      indicator,
      inflation_factor: parseFloat(inflationFactor.toFixed(4)),
      baseline_components: {
        scoring_format: scoringFormatFromMeta(),
        projection_component: Number(meta?.projection_component ?? 0),
        scarcity_component: Number(meta?.scarcity_component ?? 0),
        ...(meta?.age_depth_component != null
          ? { age_depth_component: Number(meta.age_depth_component) }
          : {}),
        ...(meta?.injury_component != null
          ? { injury_component: Number(meta.injury_component) }
          : {}),
        ...(meta?.two_way_role_selected === "hitter" ||
        meta?.two_way_role_selected === "pitcher"
          ? {
              two_way_role_selected: meta.two_way_role_selected,
              hitter_baseline_candidate: Number(meta.hitter_baseline_candidate),
              pitcher_baseline_candidate: Number(meta.pitcher_baseline_candidate),
            }
          : {}),
        ...riskExplain,
      },
      scarcity_adjustment: 0,
      inflation_adjustment: parseFloat((adjustedRounded - baselineValue).toFixed(2)),
      ...valuedPlayerMarketFieldsFromLean(p),
    };
  });
}
