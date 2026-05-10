import type { LeanPlayer } from "../types/brain";
import type { InjuryOverrideEntry } from "../types/valuation";
import { getPlayerId } from "./playerId";

/**
 * Applies request `injury_overrides` before baseline math. Last entry wins for duplicate
 * `player_id`. Severity 0 clears catalog `injurySeverity` so baseline treats the player as healthy.
 */
export function applyInjuryOverridesToPool(
  players: LeanPlayer[],
  overrides: InjuryOverrideEntry[] | undefined
): LeanPlayer[] {
  if (!overrides?.length) return players;
  const byId = new Map<string, number>();
  for (const o of overrides) {
    const sev = Math.min(3, Math.max(0, Math.trunc(Number(o.injury_severity))));
    byId.set(o.player_id, sev);
  }
  return players.map((p) => {
    const pid = getPlayerId(p);
    if (!byId.has(pid)) return p;
    const sev = byId.get(pid)!;
    const next: LeanPlayer = { ...p };
    if (sev <= 0) {
      delete next.injurySeverity;
    } else {
      next.injurySeverity = sev;
    }
    return next;
  });
}
