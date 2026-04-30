import { getPlayerId } from "../lib/playerId";
import {
  maxSurplusOverSlots,
  playerTokensFromDrafted,
  playerTokensFromLean,
  type SlotAssignmentCandidate,
} from "../lib/fantasyRosterSlots";
import type { DraftedPlayer, LeanPlayer } from "../types/brain";
import { compareSlotAssignmentCandidates } from "./replacementSlotsV2Compare";

export function buildRosteredCandidates(
  rostered: DraftedPlayer[],
  baselineById: Map<string, number>,
  deterministic: boolean,
  seed: number
): SlotAssignmentCandidate[] {
  const rows: SlotAssignmentCandidate[] = rostered.map((d) => ({
    player_id: d.player_id,
    baseline: baselineById.get(d.player_id) ?? 0,
    tokens: playerTokensFromDrafted(d),
  }));
  rows.sort((a, b) => compareSlotAssignmentCandidates(a, b, deterministic, seed));
  return rows;
}

export function buildUndraftedCandidates(
  undrafted: LeanPlayer[],
  deterministic: boolean,
  seed: number
): SlotAssignmentCandidate[] {
  const rows: SlotAssignmentCandidate[] = undrafted.map((p) => ({
    player_id: getPlayerId(p),
    baseline: p.value || 0,
    tokens: playerTokensFromLean(p),
  }));
  rows.sort((a, b) => compareSlotAssignmentCandidates(a, b, deterministic, seed));
  return rows;
}

export function computeTotalSurplusMass(params: {
  assignedIds: Set<string>;
  candidateById: Map<string, SlotAssignmentCandidate>;
  replacementValues: Record<string, number>;
  rosterSlotKeys: ReadonlySet<string>;
}): number {
  let total = 0;
  for (const id of params.assignedIds) {
    const c = params.candidateById.get(id);
    if (!c) continue;
    total += maxSurplusOverSlots(
      c.baseline,
      c.tokens,
      params.replacementValues,
      params.rosterSlotKeys
    );
  }
  return total;
}

export function buildSurplusBasisMap(
  undrafted: LeanPlayer[],
  replacementValues: Record<string, number>,
  rosterSlotKeys: ReadonlySet<string>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of undrafted) {
    const id = getPlayerId(p);
    out.set(
      id,
      maxSurplusOverSlots(
        p.value || 0,
        playerTokensFromLean(p),
        replacementValues,
        rosterSlotKeys
      )
    );
  }
  return out;
}
