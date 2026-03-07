import { filterByScope } from "../lib/leagueScope";
import {
  LeanPlayer,
  LeagueScope,
  MockPickTeam,
  PredictedPick,
  MockPickResponse,
  RosterSlot,
} from "../types/brain";

/**
 * Returns the canonical ID used to match this player against drafted_players.
 * Prefers mlbId (string) since that's what Draftroom sends; falls back to _id.
 */
function getPlayerId(p: LeanPlayer): string {
  return p.mlbId != null ? String(p.mlbId) : String(p._id);
}

/**
 * Returns true if a player is eligible for the given roster slot.
 * Handles multi-position eligibility (e.g. "2B/SS") and flex slots.
 */
function fitsSlot(playerPosition: string, slotPosition: string): boolean {
  const slot = slotPosition.toUpperCase();
  if (slot === "BN" || slot === "UTIL") return true; // flex slots accept anyone
  return playerPosition.toUpperCase().includes(slot);
}

/**
 * Calculates how urgently a team needs to fill each roster slot.
 * Returns a map of position → need ratio (higher = more urgent).
 * Need ratio = unfilled_slots / total_slots_of_that_type
 */
function calcTeamNeeds(
  team: MockPickTeam,
  rosterSlots: RosterSlot[]
): Map<string, number> {
  const needs = new Map<string, number>();

  // Count existing players per position category
  const currentCounts = new Map<string, number>();
  for (const dp of team.roster) {
    for (const slot of rosterSlots) {
      if (
        slot.position !== "BN" &&
        slot.position !== "UTIL" &&
        fitsSlot(dp.position, slot.position)
      ) {
        currentCounts.set(
          slot.position,
          (currentCounts.get(slot.position) ?? 0) + 1
        );
        break; // count the player in the first matching slot only
      }
    }
  }

  // Aggregate slot requirements
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
    if (unfilled > 0) {
      needs.set(pos, unfilled / required); // normalized urgency
    }
  }

  return needs;
}

/**
 * Predicts the most likely pick for each team in the pick_order using
 * a simple but effective ADP + team-need heuristic.
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

  const poolMap = new Map(scoped.map((p) => [getPlayerId(p), p]));
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

  // Sort available players by ADP once for efficiency
  const availableByAdp = [...available.values()].sort(
    (a, b) => (a.adp || 9999) - (b.adp || 9999)
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
      // Find the best ADP player who fits this slot
      const candidate = availableByAdp.find((p) =>
        fitsSlot(p.position, neededPos)
      );
      if (candidate) {
        chosenPlayer = candidate;
        chosenReason = `Team needs ${neededPos} (urgency ${(urgency * 100).toFixed(0)}%); best available by ADP.`;
        // Confidence scales with urgency and how early the player's ADP falls
        const adpPercentile = 1 - (candidate.adp || 200) / 300;
        confidence = Math.min(0.95, 0.5 + urgency * 0.3 + adpPercentile * 0.15);
        break;
      }
    }

    // Fallback: best available overall
    if (!chosenPlayer && availableByAdp.length > 0) {
      chosenPlayer = availableByAdp[0];
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
        adp: chosenPlayer.adp || 0,
        reason: chosenReason,
      },
      confidence: parseFloat(confidence.toFixed(2)),
    });

    // Remove player from available pool so subsequent teams can't pick them
    available.delete(chosenId);
    const removedIdx = availableByAdp.findIndex((p) => getPlayerId(p) === chosenId);
    if (removedIdx !== -1) availableByAdp.splice(removedIdx, 1);

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
