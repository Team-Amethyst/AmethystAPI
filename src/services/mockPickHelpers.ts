import type { DraftedPlayer, MockPickTeam, RosterSlot } from "../types/brain";

export function fitsSlot(playerPosition: string, slotPosition: string): boolean {
  const slot = slotPosition.toUpperCase();
  if (slot === "BN" || slot === "UTIL") return true;
  return playerPosition.toUpperCase().includes(slot);
}

export function draftedPlayerFitsSlot(
  dp: DraftedPlayer,
  slotPosition: string
): boolean {
  if (fitsSlot(dp.position, slotPosition)) return true;
  return dp.positions?.some((pos) => fitsSlot(pos, slotPosition)) ?? false;
}

export function calcTeamNeeds(
  team: MockPickTeam,
  rosterSlots: RosterSlot[]
): Map<string, number> {
  const needs = new Map<string, number>();
  const currentCounts = new Map<string, number>();
  for (const dp of team.roster) {
    for (const slot of rosterSlots) {
      if (
        slot.position !== "BN" &&
        slot.position !== "UTIL" &&
        draftedPlayerFitsSlot(dp, slot.position)
      ) {
        currentCounts.set(
          slot.position,
          (currentCounts.get(slot.position) ?? 0) + 1
        );
        break;
      }
    }
  }

  const slotTotals = new Map<string, number>();
  for (const slot of rosterSlots) {
    if (slot.position === "BN" || slot.position === "UTIL") continue;
    slotTotals.set(
      slot.position,
      (slotTotals.get(slot.position) ?? 0) + slot.count
    );
  }

  for (const [pos, required] of slotTotals) {
    const have = Math.min(currentCounts.get(pos) ?? 0, required);
    const unfilled = required - have;
    if (unfilled > 0) needs.set(pos, unfilled / required);
  }
  return needs;
}
