import type { SlotAssignmentCandidate } from "../lib/fantasyRosterSlots";

export function compareSlotAssignmentCandidates(
  a: SlotAssignmentCandidate,
  b: SlotAssignmentCandidate,
  deterministic: boolean,
  seed: number
): number {
  const diff = b.baseline - a.baseline;
  if (diff !== 0) return diff;
  if (deterministic && Number.isFinite(seed)) {
    let h = seed >>> 0;
    for (const ch of a.player_id) h = Math.imul(31, h) + ch.charCodeAt(0);
    const ha = h >>> 0;
    h = seed >>> 0;
    for (const ch of b.player_id) h = Math.imul(31, h) + ch.charCodeAt(0);
    const hb = h >>> 0;
    if (ha !== hb) return ha - hb;
  }
  return a.player_id.localeCompare(b.player_id);
}
