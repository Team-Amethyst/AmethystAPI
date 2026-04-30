import { buildLeagueSlotDemand, sumDemand } from "../lib/fantasyRosterSlots";
import type { DraftedPlayer, RosterSlot } from "../types/brain";

export function budgetPressureMultiplier(
  draftedPlayers: DraftedPlayer[],
  totalBudgetPerTeam: number,
  numTeams: number,
  budgetByTeamId: Record<string, number> | undefined,
  userTeamId: string,
  budgetRemaining: number
): number {
  let userRemaining: number;
  let leagueAvgRemaining: number;

  if (budgetByTeamId && Object.keys(budgetByTeamId).length > 0) {
    userRemaining = budgetByTeamId[userTeamId] ?? totalBudgetPerTeam;
    leagueAvgRemaining =
      Object.values(budgetByTeamId).reduce((s, v) => s + v, 0) /
      Math.max(1, Object.keys(budgetByTeamId).length);
  } else {
    let userSpent = 0;
    for (const dp of draftedPlayers) {
      if (dp.team_id !== userTeamId) continue;
      userSpent += dp.paid ?? 0;
    }
    userRemaining = Math.max(0, totalBudgetPerTeam - userSpent);
    leagueAvgRemaining = budgetRemaining / Math.max(1, numTeams);
  }

  if (userRemaining > 1.25 * leagueAvgRemaining) return 1.15;
  if (userRemaining < 0.75 * leagueAvgRemaining) return 0.85;
  return 1.0;
}

export function userBudgetRemaining(
  draftedPlayers: DraftedPlayer[],
  totalBudgetPerTeam: number,
  budgetByTeamId: Record<string, number> | undefined,
  userTeamId: string
): number {
  if (budgetByTeamId && Object.keys(budgetByTeamId).length > 0) {
    return budgetByTeamId[userTeamId] ?? totalBudgetPerTeam;
  }
  let spent = 0;
  for (const dp of draftedPlayers) {
    if (dp.team_id !== userTeamId) continue;
    spent += dp.paid ?? 0;
  }
  return Math.max(0, totalBudgetPerTeam - spent);
}

export function leagueSlotCapacity(rosterSlots: RosterSlot[], numTeams: number): number {
  return sumDemand(buildLeagueSlotDemand(rosterSlots, numTeams));
}

export function userTeamStartingSlots(rosterSlots: RosterSlot[]): number {
  let s = 0;
  for (const rs of rosterSlots) {
    const u = rs.position.toUpperCase().trim();
    if (!u || u === "BN") continue;
    s += Math.max(0, Math.floor(rs.count ?? 0));
  }
  return s;
}

export function dollarsPerSlotPeerRatio(params: {
  userRemaining: number;
  openSeatTotal: number;
  budgetRemainingLeague: number;
  numTeams: number;
  remainingSlotsLeague: number;
}): number {
  const dpsUser = params.userRemaining / Math.max(1, params.openSeatTotal);
  const peerOpen = Math.max(1, params.remainingSlotsLeague / params.numTeams);
  const peerBudget = params.budgetRemainingLeague / Math.max(1, params.numTeams);
  const dpsPeer = peerBudget / peerOpen;
  if (!Number.isFinite(dpsPeer) || dpsPeer <= 0) return 1;
  return dpsUser / dpsPeer;
}
