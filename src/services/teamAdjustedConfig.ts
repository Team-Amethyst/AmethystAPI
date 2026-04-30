export const FLEX_SLOTS = new Set(["UTIL", "CI", "MI", "P"]);

const SLOT_PRIORITY_SCORE: Record<string, number> = {
  C: 10,
  SS: 20,
  "2B": 30,
  "3B": 40,
  "1B": 50,
  OF: 60,
  SP: 70,
  RP: 80,
  UTIL: 90,
  CI: 100,
  MI: 110,
  P: 120,
};

export function isStartingSlot(slot: string): boolean {
  return slot.toUpperCase() !== "BN";
}

export function slotPriorityScore(slot: string): number {
  return SLOT_PRIORITY_SCORE[slot.toUpperCase()] ?? 200;
}
