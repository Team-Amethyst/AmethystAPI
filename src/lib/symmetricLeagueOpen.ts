import type { DraftedPlayer } from "../types/brain";

const BUDGET_EQ_EPS = 0.51;

export type SymmetricLeagueOpenInput = {
  numTeams: number;
  draftedPlayers: readonly DraftedPlayer[];
  additionalDraftedIds: readonly string[];
  budgetByTeamId?: Record<string, number> | null;
  rosteredPlayersForSlots?: readonly DraftedPlayer[] | null;
};

function defaultTeamIds(numTeams: number): string[] {
  return Array.from({ length: numTeams }, (_, i) => `team_${i + 1}`);
}

/**
 * True when every team is in the same economic/rostered posture so
 * `team_adjusted_value` should not diverge from `adjusted_value` (no
 * inter-team information yet — auction not started, no off-board asymmetry).
 */
export function isSymmetricOpenLeagueContext(
  inp: SymmetricLeagueOpenInput
): boolean {
  const {
    numTeams,
    draftedPlayers,
    additionalDraftedIds,
    budgetByTeamId,
    rosteredPlayersForSlots,
  } = inp;

  if (numTeams < 1) return false;
  if (draftedPlayers.length > 0) return false;
  if (additionalDraftedIds.length > 0) return false;

  const budgetKeys = budgetByTeamId ? Object.keys(budgetByTeamId) : [];
  if (budgetKeys.length > 0) {
    if (budgetKeys.length !== numTeams) return false;
    const vals = budgetKeys.map((k) => budgetByTeamId![k]);
    if (!vals.every((v) => typeof v === "number" && Number.isFinite(v)))
      return false;
    const v0 = vals[0]!;
    for (const v of vals) {
      if (Math.abs(v - v0) > BUDGET_EQ_EPS) return false;
    }
  }

  const teamIds =
    budgetKeys.length === numTeams
      ? [...budgetKeys].sort()
      : defaultTeamIds(numTeams);

  const counts = new Map<string, number>();
  for (const tid of teamIds) counts.set(tid, 0);

  const rostered = rosteredPlayersForSlots ?? [];
  for (const r of rostered) {
    const tid = r.team_id?.trim() || "team_1";
    if (!counts.has(tid)) return false;
    counts.set(tid, (counts.get(tid) ?? 0) + 1);
  }

  const c0 = counts.get(teamIds[0]!) ?? 0;
  for (const tid of teamIds) {
    if ((counts.get(tid) ?? 0) !== c0) return false;
  }

  return true;
}
