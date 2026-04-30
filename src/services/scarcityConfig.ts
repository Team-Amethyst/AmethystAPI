/** Positions that have exactly one starter slot per team in a standard league */
export const SINGLE_SLOT_POSITIONS = new Set(["C", "1B", "2B", "3B", "SS"]);

/** Positions where multiple starters are expected */
export const MULTI_SLOT_POSITIONS: Record<string, number> = {
  OF: 3,
  SP: 5,
  RP: 2,
};

/** Monopoly threshold: one team controls >= this share of a category */
export const MONOPOLY_THRESHOLD = 0.4;

export const TIER_TARGET_FACTORS: Record<number, number> = {
  1: 0.25,
  2: 0.5,
  3: 0.5,
  4: 0.75,
  5: 1.0,
};

export type StatPath = {
  section: "batting" | "pitching";
  field: string;
};

export const CATEGORY_STAT_PATHS: Record<string, StatPath> = {
  SV: { section: "pitching", field: "saves" },
  K: { section: "pitching", field: "strikeouts" },
  W: { section: "pitching", field: "wins" },
  HR: { section: "batting", field: "hr" },
  SB: { section: "batting", field: "sb" },
  RBI: { section: "batting", field: "rbi" },
  R: { section: "batting", field: "runs" },
};
