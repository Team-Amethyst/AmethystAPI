import { getPlayerId } from "./playerId";
import type { LeanPlayer } from "../types/brain";

/** Category strength from baseline engine meta (not ADP). Used for hybrid scarce-slot gate. */
export function categoryProjectionByIdFromPlayers(
  players: readonly LeanPlayer[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of players) {
    const meta = (
      p.projection as { __valuation_meta__?: { projection_component?: number } }
    )?.__valuation_meta__;
    if (meta?.projection_component != null) {
      m.set(getPlayerId(p), meta.projection_component);
    }
  }
  return m;
}
