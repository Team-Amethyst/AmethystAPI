import type { DraftedPlayer, RosterSlot } from "../types/brain";

/**
 * League-wide roster slots still to be filled by auction + keeper context,
 * derived only from `roster_slots`, `num_teams`, auction picks, and off-board
 * ids (keepers / minors / taxi) — no per-slot counts from Draft.
 *
 * `slots_per_team` = Σ `roster_slots[].count`; capacity = `slots_per_team × num_teams`.
 * Filled = unique `player_id` in `drafted_players` ∪ `offboard_player_ids`.
 */
export function computeRemainingLeagueRosterSlots(
  rosterSlots: RosterSlot[],
  numTeams: number,
  draftedPlayers: DraftedPlayer[],
  offboardPlayerIds: readonly string[]
): number {
  const slotsPerTeam = rosterSlots.reduce((s, r) => s + (r.count ?? 0), 0);
  const capacity = Math.max(0, slotsPerTeam * numTeams);
  const filled = new Set<string>();
  for (const d of draftedPlayers) {
    if (d.player_id) filled.add(d.player_id);
  }
  for (const id of offboardPlayerIds) {
    if (id) filled.add(id);
  }
  return Math.max(0, capacity - filled.size);
}
