import type { ValuedPlayer } from "../types/brain";

/**
 * Tunable knobs for team-aware `max_bid` (hard stop). Premiums stack with a
 * global cap so `baseline_value` cannot inflate bids without bound; missing
 * future inputs can add new partial terms alongside these.
 */
export const MAX_BID_TUNING = {
  /** baseline_tier 1 (top quintile): fraction of base */
  elite_tier1_frac: 0.026,
  /** baseline_tier 2 */
  elite_tier2_frac: 0.013,
  /** Max sum of positive premium dollars as fraction of base (anti runaway) */
  premium_stack_cap_frac: 0.052,
  /** Weight on (slot_scarcity_mult − 1)+ */
  slot_scarcity_k: 0.34,
  /** Weight on (need_mult − 1)+ — skipped when symmetricOpen */
  need_fit_k: 0.2,
  /** Weight on (replacement_dropoff_mult − 1)+ — skipped when symmetricOpen */
  replacement_dropoff_k: 0.15,
  /** Small bonus when dollars_per_slot mult > 1 — capped; skipped when symmetricOpen */
  dps_rich_cap_frac: 0.022,
  dps_rich_k: 0.09,
  /** Penalty scale when budget_mult < 1 */
  budget_tight_k: 0.42,
  /**
   * Roster flexibility penalty when few open starting seats remain
   * (`open_fraction` = openSeats / userCap). Uses (1 − open_fraction).
   */
  roster_tight_k: 0.036,
  /** Hard ceiling: max_bid ≤ base × (1 + headroom) after premiums */
  base_headroom_frac: 0.084,
  /** Also cap vs league FMV so baseline list cannot dominate */
  adjusted_headroom_frac: 0.095,
} as const;

export type MaxBidMultiplierSnapshot = {
  need: number;
  budget: number;
  dollars_per_slot: number;
  slot_scarcity: number;
  replacement_dropoff: number;
};

/**
 * Team hard-stop auction price: starts from marginal team dollars, applies
 * small controlled premiums/penalties, then absolute ceilings vs base and
 * `adjusted_value` (auction FMV). When the FMV headroom ceiling binds, two
 * teams can share the same numeric result even if `team_adjusted_value` differs.
 */
export function computeMaxBidDollars(params: {
  row: ValuedPlayer;
  /** `team_adjusted_value` when set, else `adjusted_value` */
  base: number;
  adjustedValue: number;
  minAuctionBid: number;
  multipliers: MaxBidMultiplierSnapshot;
  symmetricOpen: boolean;
  /** open starting seats / user starting capacity (0–1); 1 = empty roster */
  openSeatFraction: number;
}): number {
  const {
    row,
    base: baseRaw,
    adjustedValue,
    minAuctionBid,
    multipliers: m,
    symmetricOpen,
    openSeatFraction,
  } = params;
  const base = Math.max(minAuctionBid, baseRaw);
  const av = Math.max(minAuctionBid, adjustedValue);

  let elite = 0;
  if (row.baseline_tier <= 1) elite = base * MAX_BID_TUNING.elite_tier1_frac;
  else if (row.baseline_tier === 2) elite = base * MAX_BID_TUNING.elite_tier2_frac;

  const slotPrem = Math.max(0, m.slot_scarcity - 1) * base * MAX_BID_TUNING.slot_scarcity_k;

  let needPrem = 0;
  let dropPrem = 0;
  let dpsPrem = 0;
  if (!symmetricOpen) {
    needPrem = Math.max(0, m.need - 1) * base * MAX_BID_TUNING.need_fit_k;
    dropPrem =
      Math.max(0, m.replacement_dropoff - 1) * base * MAX_BID_TUNING.replacement_dropoff_k;
    if (m.dollars_per_slot > 1) {
      dpsPrem = Math.min(
        base * MAX_BID_TUNING.dps_rich_cap_frac,
        (m.dollars_per_slot - 1) * base * MAX_BID_TUNING.dps_rich_k
      );
    }
  }

  const posPremRaw = elite + slotPrem + needPrem + dropPrem + dpsPrem;
  const premCap = base * MAX_BID_TUNING.premium_stack_cap_frac;
  const posPrem = Math.min(posPremRaw, premCap);

  const budgetPen =
    m.budget < 1 ? (1 - m.budget) * base * MAX_BID_TUNING.budget_tight_k : 0;

  const of = Math.max(0, Math.min(1, openSeatFraction));
  const rosterTightPen = (1 - of) * base * MAX_BID_TUNING.roster_tight_k;

  let raw = base + posPrem - budgetPen - rosterTightPen;
  raw = Math.max(minAuctionBid, raw);

  const headBase = base * (1 + MAX_BID_TUNING.base_headroom_frac);
  const headAdj = av * (1 + MAX_BID_TUNING.adjusted_headroom_frac);
  const out = Math.min(raw, headBase, headAdj);
  return parseFloat(Math.max(minAuctionBid, out).toFixed(2));
}
