import { filterByScope } from "../lib/leagueScope";
import { getPlayerId } from "../lib/playerId";
import {
  LeanPlayer,
  LeagueScope,
  MockPickTeam,
  PredictedPick,
  MockPickResponse,
  RosterSlot,
} from "../types/brain";
import { calcTeamNeeds, fitsSlot } from "./mockPickHelpers";

/**
 * Predicts the most likely pick for each team in the pick_order using
 * a simple but effective catalog-rank + team-need heuristic.
 *
 * Algorithm:
 *   1. For each team in pick order:
 *      a. Calculate roster needs (unfilled slot ratios).
 *      b. Sort needs by urgency descending.
 *      c. For the most urgent position, take the highest-ADP-ranked available player.
 *      d. If no player fits the top need, fall back to next need, then best available overall.
 *   2. Mark the predicted player as drafted before moving to the next team.
 */
export function simulateMockPicks(
  allPlayers: LeanPlayer[],
  teams: MockPickTeam[],
  pickOrder: string[],
  rosterSlots: RosterSlot[],
  availablePlayerIds?: string[],
  leagueScope?: LeagueScope
): MockPickResponse {
  const scoped = filterByScope(allPlayers, leagueScope || "Mixed");

  // Build available pool
  const allDraftedIds = new Set(
    teams.flatMap((t) => t.roster.map((p) => p.player_id))
  );

  const poolMap = new Map<string, LeanPlayer>(
    scoped.map((p): [string, LeanPlayer] => [getPlayerId(p), p])
  );
  const explicitPool = availablePlayerIds
    ? new Set(availablePlayerIds)
    : null;

  const available = new Map<string, LeanPlayer>(
    [...poolMap].filter(([id, _]) => {
      if (allDraftedIds.has(id)) return false;
      if (explicitPool && !explicitPool.has(id)) return false;
      return true;
    })
  );

  // Sort available players by catalog_rank once for efficiency
  const availableByCatalogRank = [...available.values()].sort(
    (a, b) => (a.catalog_rank || 9999) - (b.catalog_rank || 9999)
  );

  const teamMap = new Map(teams.map((t) => [t.team_id, { ...t, roster: [...t.roster] }]));
  const predictions: PredictedPick[] = [];

  for (let pickIdx = 0; pickIdx < pickOrder.length; pickIdx++) {
    const teamId = pickOrder[pickIdx];
    const team = teamMap.get(teamId);
    if (!team) continue;

    const needs = calcTeamNeeds(team, rosterSlots);

    // Sort positions by urgency (highest first)
    const sortedNeeds = [...needs.entries()].sort((a, b) => b[1] - a[1]);

    let chosenPlayer: LeanPlayer | null = null;
    let chosenReason = "";
    let confidence = 0.5;

    for (const [neededPos, urgency] of sortedNeeds) {
      // Find the best catalog-ranked player who fits this slot
      const candidate = availableByCatalogRank.find((p) =>
        fitsSlot(p.position, neededPos)
      );
      if (candidate) {
        chosenPlayer = candidate;
        chosenReason = `Team needs ${neededPos} (urgency ${(urgency * 100).toFixed(0)}%); best available by catalog rank.`;
        // Confidence scales with urgency and how early the player's catalog_rank falls
        const rankPercentile = 1 - (candidate.catalog_rank || 200) / 300;
        confidence = Math.min(0.95, 0.5 + urgency * 0.3 + rankPercentile * 0.15);
        break;
      }
    }

    // Fallback: best available overall
    if (!chosenPlayer && availableByCatalogRank.length > 0) {
      chosenPlayer = availableByCatalogRank[0];
      chosenReason = "Best available player overall (no specific positional need unmet).";
      confidence = 0.40;
    }

    if (!chosenPlayer) break; // Pool exhausted

    const chosenId = getPlayerId(chosenPlayer);

    predictions.push({
      team_id: teamId,
      pick_position: pickIdx + 1,
      predicted_player: {
        player_id: chosenId,
        name: chosenPlayer.name,
        position: chosenPlayer.position,
        catalog_rank: chosenPlayer.catalog_rank || 0,
        reason: chosenReason,
      },
      confidence: parseFloat(confidence.toFixed(2)),
    });

    // Remove player from available pool so subsequent teams can't pick them
    available.delete(chosenId);
    const removedIdx = availableByCatalogRank.findIndex((p) => getPlayerId(p) === chosenId);
    if (removedIdx !== -1) availableByCatalogRank.splice(removedIdx, 1);

    // "Draft" the player onto the team for subsequent need calculations
    team.roster.push({
      player_id: chosenId,
      name: chosenPlayer.name,
      position: chosenPlayer.position,
      team: chosenPlayer.team,
      team_id: teamId,
    });
  }

  return {
    predictions,
    simulated_at: new Date().toISOString(),
  };
}
