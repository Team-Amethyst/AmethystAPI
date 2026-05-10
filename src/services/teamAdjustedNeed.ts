import {
  fitsRosterSlot,
  playerTokensFromLean,
  type PositionOverrideMap,
} from "../lib/fantasyRosterSlots";
import type { LeanPlayer } from "../types/brain";

/**
 * Primary roster slots (C, 1B–OF, SP, RP, …) — each open seat counts toward need boost.
 * Capped so TA stays in line with historical ~1.25–1.28 max from primary path.
 */
const PRIMARY_BOOST_CAP = 0.28;
const PRIMARY_BOOST_PER_PRIMARY_SEAT = 0.25;
const PRIMARY_BOOST_PER_EXTRA_PRIMARY_CHAIN = 0.04;

/**
 * When primary seats are open, remaining flex holes add a small tiered supplement.
 */
const SUPP_CI_MI = 0.012;
const SUPP_UTIL = 0.008;
const SUPP_P = 0.01;

/**
 * Flex tiers (UTIL / CI / MI / generic P) — CI & MI strongest, UTIL weakest, P middle.
 * Total flex-only boost remains capped ~0.10 (legacy flex plateau).
 */
const FLEX_BOOST_CAP = 0.1;
/** Open CI or MI seat — corner/coverage infield flex. */
const W_CI_MI = 0.052;
/** Open UTIL seat — weakest hitter flex signal. */
const W_UTIL = 0.036;
/** Open generic P seat — broader pitcher placement, weaker than SP/RP primaries. */
const W_P = 0.044;

/** All fitting starting slots are full — roster already carries this player type. */
const FILLED_LINEUP_NEED = 0.85;

/**
 * Single source of truth for audits/docs — mirrors {@link positionalNeedMultiplier}.
 * Flex tiers: CI/MI > generic P > UTIL; flex-only boost capped at FLEX_BOOST_CAP (~1.10×).
 */
export const POSITIONAL_NEED_FORMULA_REFERENCE = {
  PRIMARY_BOOST_CAP,
  PRIMARY_BOOST_PER_PRIMARY_SEAT,
  PRIMARY_BOOST_PER_EXTRA_PRIMARY_CHAIN,
  flex_supplement_weights: {
    CI_MI: SUPP_CI_MI,
    UTIL: SUPP_UTIL,
    P: SUPP_P,
  },
  FLEX_BOOST_CAP,
  flex_only_weights_per_open_seat: {
    CI_MI: W_CI_MI,
    UTIL: W_UTIL,
    P: W_P,
  },
  FILLED_LINEUP_NEED,
  bench_ignored: ["BN"] as const,
  formulas: {
    primary_path:
      "need = 1 + min(PRIMARY_BOOST_CAP, PRIMARY_BOOST_PER_PRIMARY_SEAT*u + PRIMARY_BOOST_PER_EXTRA_PRIMARY_CHAIN*max(0,u-1) + SUPP_CI_MI*ciMi + SUPP_UTIL*util + SUPP_P*p_open) when u = primary open units fitting the player",
    flex_only_path:
      "need = 1 + min(FLEX_BOOST_CAP, W_CI_MI*ciMi + W_UTIL*util + W_P*p_open) when u = 0 but flex opens fit",
    filled_but_still_eligible_starting_slot:
      "need = FILLED_LINEUP_NEED when every fitting slot is covered (no positive open count)",
    no_starting_slot_fits: "need = 1",
  },
} as const;

function isBenchSlotKey(slot: string): boolean {
  return slot.toUpperCase().trim() === "BN";
}

function isFlexSlotKey(slot: string): boolean {
  const u = slot.toUpperCase().trim();
  return u === "UTIL" || u === "CI" || u === "MI" || u === "P";
}

export type FlexTierUnits = {
  ciMiUnits: number;
  utilUnits: number;
  pUnits: number;
};

/**
 * Sums open seats by slot type the player fits. Bench slots are ignored (never in typical
 * open-slot maps from `buildOpenSlotsForUserTeam`, but skipped defensively).
 */
export function aggregateNeedSlotUnits(
  openSlots: Map<string, number>,
  tokens: readonly string[]
): { primaryOpenUnits: number; flex: FlexTierUnits } {
  let primaryOpenUnits = 0;
  let ciMiUnits = 0;
  let utilUnits = 0;
  let pUnits = 0;

  for (const slot of openSlots.keys()) {
    if (isBenchSlotKey(slot)) continue;
    const open = openSlots.get(slot) ?? 0;
    if (open <= 0) continue;
    if (!fitsRosterSlot(slot, tokens)) continue;
    const u = slot.toUpperCase().trim();
    if (u === "UTIL") {
      utilUnits += open;
    } else if (u === "CI" || u === "MI") {
      ciMiUnits += open;
    } else if (u === "P") {
      pUnits += open;
    } else if (!isFlexSlotKey(slot)) {
      primaryOpenUnits += open;
    }
  }

  return {
    primaryOpenUnits,
    flex: { ciMiUnits, utilUnits, pUnits },
  };
}

function flexBoostFromTiers(flex: FlexTierUnits): number {
  const linear =
    W_CI_MI * flex.ciMiUnits +
    W_UTIL * flex.utilUnits +
    W_P * flex.pUnits;
  return Math.min(FLEX_BOOST_CAP, linear);
}

function primaryBoostLinear(
  primaryOpenUnits: number,
  flex: FlexTierUnits
): number {
  const primaryLinear =
    PRIMARY_BOOST_PER_PRIMARY_SEAT * primaryOpenUnits +
    PRIMARY_BOOST_PER_EXTRA_PRIMARY_CHAIN *
      Math.max(0, primaryOpenUnits - 1);
  const flexSupplement =
    SUPP_CI_MI * flex.ciMiUnits +
    SUPP_UTIL * flex.utilUnits +
    SUPP_P * flex.pUnits;
  return primaryLinear + flexSupplement;
}

/**
 * Slot-aware positional need: primary seats strongest; flex split into CI/MI vs UTIL vs P.
 */
export function positionalNeedMultiplier(
  p: LeanPlayer,
  openSlots: Map<string, number>,
  positionOverrides?: PositionOverrideMap
): number {
  const tokens = playerTokensFromLean(p, positionOverrides);
  const slots = [...openSlots.keys()].filter((s) => !isBenchSlotKey(s));
  const { primaryOpenUnits, flex } = aggregateNeedSlotUnits(openSlots, tokens);

  if (primaryOpenUnits > 0) {
    const linear = primaryBoostLinear(primaryOpenUnits, flex);
    const boost = Math.min(PRIMARY_BOOST_CAP, linear);
    return Number((1 + boost).toFixed(4));
  }

  const flexOnlyBoost = flexBoostFromTiers(flex);
  if (flexOnlyBoost > 0) {
    return Number((1 + flexOnlyBoost).toFixed(4));
  }

  const fitsAnyStarting = slots.some((slot) => fitsRosterSlot(slot, tokens));
  if (fitsAnyStarting) return FILLED_LINEUP_NEED;

  return 1.0;
}
