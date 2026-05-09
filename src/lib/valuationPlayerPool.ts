import { filterByScope } from "./leagueScope";
import { getPlayerId } from "./playerId";
import type { LeanPlayer, LeagueScope } from "../types/brain";

export type ValuationUniverseFilter = {
  leagueScope: LeagueScope;
  /** If non-empty, only these catalog ids (mlbId / _id string) are kept. */
  eligiblePlayerIds?: string[];
  /** Remove these catalog ids from the pool after other filters. */
  excludedPlayerIds?: string[];
};

/**
 * Single source of truth for which catalog rows participate in baseline z-scores,
 * replacement levels, and inflation. Call once per request before baseline + inflation.
 *
 * Filter order: (1) `league_scope`, (2) `eligible_player_ids` if non-empty,
 * (3) `excluded_player_ids` if non-empty.
 */
export function filterValuationUniverse(
  players: LeanPlayer[],
  params: ValuationUniverseFilter
): LeanPlayer[] {
  let rows = filterByScope(players, params.leagueScope);
  const elig = params.eligiblePlayerIds;
  if (elig && elig.length > 0) {
    const allow = new Set(elig);
    rows = rows.filter((p) => allow.has(getPlayerId(p)));
  }
  const excl = params.excludedPlayerIds;
  if (excl && excl.length > 0) {
    const deny = new Set(excl);
    rows = rows.filter((p) => !deny.has(getPlayerId(p)));
  }
  return rows;
}
