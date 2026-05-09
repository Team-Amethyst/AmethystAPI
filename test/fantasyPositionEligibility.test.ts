/**
 * Slot-fit matrix for multi-position fantasy tokens (single source: fitsRosterSlot).
 */
import { describe, expect, it } from "vitest";
import {
  fitsRosterSlot,
  tokenizeFantasyPositions,
} from "../src/lib/fantasyRosterSlots";

describe("fitsRosterSlot multi-position eligibility", () => {
  it('["2B","OF"] fits 2B, OF, MI, UTIL, and BN', () => {
    const t = tokenizeFantasyPositions("2B", ["OF"]);
    for (const slot of ["2B", "OF", "MI", "UTIL", "BN"] as const) {
      expect(fitsRosterSlot(slot, t)).toBe(true);
    }
  });

  it('["1B","3B"] fits 1B, 3B, CI, UTIL, and BN', () => {
    const t = tokenizeFantasyPositions("1B", ["3B"]);
    for (const slot of ["1B", "3B", "CI", "UTIL", "BN"] as const) {
      expect(fitsRosterSlot(slot, t)).toBe(true);
    }
  });
});
