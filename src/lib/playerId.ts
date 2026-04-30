import type { LeanPlayer } from "../types/brain";

/**
 * Canonical ID used to match catalog rows against drafted/off-board inputs.
 * Prefers `mlbId` (Draftroom contract) and falls back to Mongo `_id`.
 */
export function getPlayerId(player: LeanPlayer): string {
  return player.mlbId != null ? String(player.mlbId) : String(player._id);
}
