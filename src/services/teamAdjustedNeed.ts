import { fitsRosterSlot, playerTokensFromLean } from "../lib/fantasyRosterSlots";
import type { LeanPlayer } from "../types/brain";
import { FLEX_SLOTS } from "./teamAdjustedConfig";

export function positionalNeedMultiplier(
  p: LeanPlayer,
  openSlots: Map<string, number>
): number {
  const tokens = playerTokensFromLean(p);
  const slots = [...openSlots.keys()];
  const hasOpenPrimary = slots.some((slot) => {
    const u = slot.toUpperCase();
    return (
      !FLEX_SLOTS.has(u) &&
      (openSlots.get(slot) ?? 0) > 0 &&
      fitsRosterSlot(slot, tokens)
    );
  });
  if (hasOpenPrimary) return 1.25;

  const hasOpenFlex = slots.some((slot) => {
    const u = slot.toUpperCase();
    return FLEX_SLOTS.has(u) && (openSlots.get(slot) ?? 0) > 0 && fitsRosterSlot(u, tokens);
  });
  if (hasOpenFlex) return 1.1;

  const fitsAnyStarting = slots.some((slot) => fitsRosterSlot(slot, tokens));
  if (fitsAnyStarting) return 0.85;

  return 1.0;
}
