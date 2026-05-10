import type { DraftedPlayer } from "../types/brain";

export type ValuationContextMetrics = {
  eligible_pool_size: number;
  roster_demand_slots: number;
  pool_to_slot_ratio: number | null;
};

export type ValuationContextWarningInput = {
  eligiblePoolSize: number;
  rosterDemandSlots: number;
  /** True when request used a non-empty eligible_player_ids filter. */
  customEligibleUniverse: boolean;
  rosteredPlayers: readonly DraftedPlayer[];
};

/**
 * Response-level pool vs roster demand for UI / analytics (same numbers used in thin-pool warnings).
 */
export function buildValuationContextMetrics(params: {
  eligiblePoolSize: number;
  rosterDemandSlots: number;
}): ValuationContextMetrics {
  const ratio =
    params.rosterDemandSlots > 0
      ? params.eligiblePoolSize / params.rosterDemandSlots
      : null;
  return {
    eligible_pool_size: params.eligiblePoolSize,
    roster_demand_slots: params.rosterDemandSlots,
    pool_to_slot_ratio:
      ratio != null && Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : null,
  };
}

/**
 * Non-fatal trust warnings when inputs produce an unrealistic or thin valuation universe.
 */
export function buildValuationContextWarnings(
  inp: ValuationContextWarningInput
): string[] {
  const w: string[] = [];
  const { eligiblePoolSize, rosterDemandSlots, customEligibleUniverse, rosteredPlayers } =
    inp;

  if (rosterDemandSlots > 0 && eligiblePoolSize < rosterDemandSlots) {
    w.push(
      "Eligible catalog pool is smaller than empty roster slots remaining league-wide; replacement levels and auction_value can be distorted."
    );
  }

  const ratio =
    rosterDemandSlots > 0 ? eligiblePoolSize / rosterDemandSlots : null;
  if (ratio != null && ratio < 1.15) {
    w.push(
      `Player pool is thin versus roster demand (pool_to_slot_ratio=${ratio.toFixed(2)}). Below ~1.15–1.2, surplus inflation often concentrates on a handful of stars — compare auction_value to a full-catalog run.`
    );
  }

  if (customEligibleUniverse && eligiblePoolSize < 200) {
    w.push(
      "Custom eligible_player_ids produced a small universe; mid-tier prices are compressed and top-end auction_value can look inflated versus a full catalog."
    );
  }

  if (rosteredPlayers.length >= 10) {
    const byTeam = new Map<string, number>();
    for (const r of rosteredPlayers) {
      const tid = (r.team_id ?? "").trim() || "unknown";
      byTeam.set(tid, (byTeam.get(tid) ?? 0) + 1);
    }
    const max = Math.max(0, ...byTeam.values());
    if (max / rosteredPlayers.length >= 0.55) {
      w.push(
        "Off-board roster players are highly concentrated on one team_id; team_adjusted_value and monopoly-style market notes may dominate — this is not a neutral symmetric open auction."
      );
    }
  }

  return w;
}
