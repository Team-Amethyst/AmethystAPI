export const REPLACEMENT_SLOTS_V2_MIN_BID = 1;

/** Slot-tail percentiles for replacement $ (see replacement v2 design notes). */
export const SLOT_REPLACEMENT_PERCENTILE: Record<string, number> = {
  C: 0.28,
  "1B": 0.22,
  "2B": 0.24,
  "3B": 0.23,
  SS: 0.24,
  OF: 0.2,
  CI: 0.26,
  MI: 0.26,
  UTIL: 0.32,
  SP: 0.35,
  RP: 0.34,
  P: 0.35,
  BN: 0.5,
};

export const SLOT_REPLACEMENT_DEFAULT_PERCENTILE = 0.24;
