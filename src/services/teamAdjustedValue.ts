import {
  buildLeagueSlotDemand,
  fitsRosterSlot,
  playerTokensFromDrafted,
  playerTokensFromLean,
  sumDemand,
} from "../lib/fantasyRosterSlots";
import type { DraftedPlayer, LeanPlayer, RosterSlot, ValuedPlayer } from "../types/brain";
import { isStartingSlot, slotPriorityScore } from "./teamAdjustedConfig";
import { positionalNeedMultiplier } from "./teamAdjustedNeed";

export function buildOpenSlotsForUserTeam(
  rosterSlots: RosterSlot[],
  rosteredPlayersForSlots: DraftedPlayer[] | undefined,
  userTeamId: string
): Map<string, number> {
  const open = new Map<string, number>();
  for (const rs of rosterSlots) {
    const slot = rs.position.toUpperCase().trim();
    if (!slot || !isStartingSlot(slot)) continue;
    open.set(slot, (open.get(slot) ?? 0) + Math.max(0, Math.floor(rs.count ?? 0)));
  }
  const teamRows = (rosteredPlayersForSlots ?? []).filter(
    (p) => p.team_id === userTeamId
  );
  const sortedSlots = [...open.keys()].sort(
    (a, b) => slotPriorityScore(a) - slotPriorityScore(b)
  );
  for (const row of teamRows) {
    const tokens = playerTokensFromDrafted(row);
    for (const slot of sortedSlots) {
      const need = open.get(slot) ?? 0;
      if (need <= 0) continue;
      if (!fitsRosterSlot(slot, tokens)) continue;
      open.set(slot, need - 1);
      break;
    }
  }
  return open;
}

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

export function maxReplacementDropoff(
  baseline: number,
  tokens: readonly string[],
  repl: Record<string, number>,
  slotKeys: ReadonlySet<string>
): number {
  let best = 0;
  for (const slot of slotKeys) {
    if (!fitsRosterSlot(slot, tokens)) continue;
    best = Math.max(best, baseline - (repl[slot] ?? 0));
  }
  return Math.max(0, best);
}

export function bestReplacementForPlayer(
  tokens: readonly string[],
  repl: Record<string, number>,
  slotKeys: ReadonlySet<string>
): { key: string; value: number } | null {
  let best: { key: string; value: number } | null = null;
  for (const slot of slotKeys) {
    if (!fitsRosterSlot(slot, tokens)) continue;
    const v = repl[slot];
    if (v == null || !Number.isFinite(v)) continue;
    if (!best || v < best.value) best = { key: slot, value: v };
  }
  return best;
}

export function teamAdjustedMultipliers(params: {
  row: ValuedPlayer;
  lp: LeanPlayer;
  openSlots: Map<string, number>;
  budgetMult: number;
  dpsMult: number;
  slotScarcityMult: number;
  replForTeam: Record<string, number>;
  rosterSlotKeysForFit: ReadonlySet<string>;
}): {
  need: number;
  budget: number;
  dollars_per_slot: number;
  slot_scarcity: number;
  replacement_dropoff: number;
} {
  const {
    row,
    lp,
    openSlots,
    budgetMult,
    dpsMult,
    slotScarcityMult,
    replForTeam,
    rosterSlotKeysForFit,
  } = params;
  const needMult = positionalNeedMultiplier(lp, openSlots);
  const tokens = playerTokensFromLean(lp);
  const drop = maxReplacementDropoff(
    row.baseline_value,
    tokens,
    replForTeam,
    rosterSlotKeysForFit
  );
  const dropMult =
    Object.keys(replForTeam).length > 0
      ? 1 + 0.22 * Math.min(1.25, drop / Math.max(8, row.baseline_value))
      : 1;
  return {
    need: needMult,
    budget: budgetMult,
    dollars_per_slot: dpsMult,
    slot_scarcity: slotScarcityMult,
    replacement_dropoff: dropMult,
  };
}

export function computeTeamAdjustedValue(params: {
  row: ValuedPlayer;
  multipliers: {
    need: number;
    budget: number;
    dollars_per_slot: number;
    slot_scarcity: number;
    replacement_dropoff: number;
  };
}): number {
  const { row, multipliers } = params;
  const rawTeam =
    row.adjusted_value *
    multipliers.need *
    multipliers.budget *
    multipliers.dollars_per_slot *
    multipliers.slot_scarcity *
    multipliers.replacement_dropoff;
  const saneCap = Math.min(
    8000,
    Math.max(
      row.adjusted_value * 6,
      row.baseline_value * 4 + row.adjusted_value
    )
  );
  return parseFloat(Math.max(0, Math.min(saneCap, rawTeam)).toFixed(2));
}
