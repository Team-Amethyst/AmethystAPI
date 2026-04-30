import type {
  CalculateInflationOptions,
  InflationModel,
  LeanPlayer,
  ValueIndicator,
  ValuedPlayer,
} from "../types/brain";
import { getPlayerId } from "../lib/playerId";
import type { ReplacementSlotsV2Result } from "./replacementSlotsV2";

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

export function compareByAdpAsc(
  a: LeanPlayer,
  b: LeanPlayer,
  options?: CalculateInflationOptions
): number {
  const diff = (a.adp || 9999) - (b.adp || 9999);
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
  valueRank: Map<string, number>;
  adpRank: Map<string, number>;
  undraftedCount: number;
}): ValuedPlayer[] {
  const {
    byValueRows,
    inflationModelEffective,
    v2Result,
    replacementValue,
    inflationFactor,
    minAuctionBid,
    valueRank,
    adpRank,
    undraftedCount,
  } = params;
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
      } else {
        adjustedValue = parseFloat((minAuctionBid + inflationFactor * sb).toFixed(2));
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
      p.projection as
        | {
            __valuation_meta__?: {
              scoring_format?: "5x5" | "6x6" | "points";
              projection_component?: number;
              scarcity_component?: number;
            };
          }
        | undefined
    )?.__valuation_meta__;

    let indicator: ValueIndicator = "Fair Value";
    if (undraftedCount > 0) {
      const vRank = valueRank.get(pid) ?? 0;
      const aRank = adpRank.get(pid) ?? 0;
      if (aRank > vRank * STEAL_SLOPE) indicator = "Steal";
      else if (aRank < vRank * REACH_SLOPE) indicator = "Reach";
    }

    return {
      player_id: pid,
      name: p.name,
      position: p.position,
      team: p.team,
      adp: p.adp || 0,
      tier: p.tier || 0,
      baseline_value: baselineValue,
      adjusted_value: adjustedValue,
      indicator,
      inflation_factor: parseFloat(inflationFactor.toFixed(4)),
      baseline_components: {
        scoring_format: meta?.scoring_format ?? "default",
        projection_component: meta?.projection_component ?? 0,
        scarcity_component: meta?.scarcity_component ?? 0,
      },
      scarcity_adjustment: 0,
      inflation_adjustment: parseFloat((adjustedValue - baselineValue).toFixed(2)),
    };
  });
}
