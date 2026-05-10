import type { LeanPlayer, ValuedPlayer } from "../types/brain";
import type { PositionOverrideMap } from "./fantasyPositioning";
import { playerTokensFromLean } from "./fantasyPositioning";
import { isPitcherForBaseline } from "../services/baselineProjectionStats";

export type PitcherHarnessRow = {
  player_id: string;
  name: string;
  position: string;
  auction_value: number;
};

export type PitcherHarnessSplits = {
  /** Pitchers with SP eligibility token (includes SP+RP dual). */
  top10Sp: PitcherHarnessRow[];
  /** Pitchers with RP eligibility token (includes SP+RP dual). */
  top10Rp: PitcherHarnessRow[];
  /** RP-eligible pitchers only — top 20 by auction_value (reliever/closer focus). */
  top20RpClosersStyle: PitcherHarnessRow[];
  /** RP-eligible pitchers ranked 10–19 by auction_value (0-based ranks 9–18). */
  midTierRp_ranks_10_to_19: PitcherHarnessRow[];
  midTierRp_ranks_10_to_19_sum_auction: number;
};

function mapRow(r: ValuedPlayer): PitcherHarnessRow {
  return {
    player_id: r.player_id,
    name: r.name ?? "",
    position: r.position ?? "",
    auction_value: r.auction_value,
  };
}

/**
 * SP/RP-style splits for valuation harness JSON (walkthrough + calibration).
 * Uses catalog eligibility tokens (`playerTokensFromLean`), not roster slot rows.
 */
export function buildPitcherHarnessSplits(
  rows: ValuedPlayer[],
  poolById: Map<string, LeanPlayer>,
  ov: PositionOverrideMap | undefined
): PitcherHarnessSplits {
  const pitcherRows = rows.filter((r) => {
    const lp = poolById.get(r.player_id);
    return lp != null && isPitcherForBaseline(lp, ov);
  });
  const spRows = pitcherRows
    .filter((r) => {
      const lp = poolById.get(r.player_id);
      if (!lp) return false;
      return playerTokensFromLean(lp, ov).includes("SP");
    })
    .sort((a, b) => b.auction_value - a.auction_value);
  const rpRows = pitcherRows
    .filter((r) => {
      const lp = poolById.get(r.player_id);
      if (!lp) return false;
      return playerTokensFromLean(lp, ov).includes("RP");
    })
    .sort((a, b) => b.auction_value - a.auction_value);
  const mid = rpRows.slice(9, 19);
  const midSum = mid.reduce((s, r) => s + r.auction_value, 0);
  return {
    top10Sp: spRows.slice(0, 10).map(mapRow),
    top10Rp: rpRows.slice(0, 10).map(mapRow),
    top20RpClosersStyle: rpRows.slice(0, 20).map(mapRow),
    midTierRp_ranks_10_to_19: mid.map(mapRow),
    midTierRp_ranks_10_to_19_sum_auction: midSum,
  };
}
