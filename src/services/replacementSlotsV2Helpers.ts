import { getPlayerId } from "../lib/playerId";
import {
  maxSurplusOverSlots,
  playerTokensFromDrafted,
  playerTokensFromLean,
  type PositionOverrideMap,
  type SlotAssignmentCandidate,
} from "../lib/fantasyRosterSlots";
import type { DraftedPlayer, LeanPlayer } from "../types/brain";
import { compareSlotAssignmentCandidates } from "./replacementSlotsV2Compare";

export function buildRosteredCandidates(
  rostered: DraftedPlayer[],
  baselineById: Map<string, number>,
  deterministic: boolean,
  seed: number,
  positionOverrides?: PositionOverrideMap
): SlotAssignmentCandidate[] {
  const rows: SlotAssignmentCandidate[] = rostered.map((d) => ({
    player_id: d.player_id,
    baseline: baselineById.get(d.player_id) ?? 0,
    tokens: playerTokensFromDrafted(d, positionOverrides),
  }));
  rows.sort((a, b) => compareSlotAssignmentCandidates(a, b, deterministic, seed));
  return rows;
}

export function buildUndraftedCandidates(
  undrafted: LeanPlayer[],
  deterministic: boolean,
  seed: number,
  positionOverrides?: PositionOverrideMap
): SlotAssignmentCandidate[] {
  const rows: SlotAssignmentCandidate[] = undrafted.map((p) => ({
    player_id: getPlayerId(p),
    baseline: p.value || 0,
    tokens: playerTokensFromLean(p, positionOverrides),
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
  rosterSlotKeys: ReadonlySet<string>,
  positionOverrides?: PositionOverrideMap
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of undrafted) {
    const id = getPlayerId(p);
    out.set(
      id,
      maxSurplusOverSlots(
        p.value || 0,
        playerTokensFromLean(p, positionOverrides),
        replacementValues,
        rosterSlotKeys
      )
    );
  }
  return out;
}

/**
 * Split `surplus_cash` across draftable players with convex weights so elites
 * receive more than a flat linear factor when surplus_basis clusters at the top.
 */
export function buildConvexSurplusDollars(params: {
  surplusCash: number;
  draftablePlayerIds: readonly string[];
  surplusBasisById: Map<string, number>;
  baselineById: Map<string, number>;
  exponent: number;
}): Map<string, number> {
  const out = new Map<string, number>();
  const { surplusCash, draftablePlayerIds, surplusBasisById, baselineById, exponent } =
    params;
  if (surplusCash <= 0 || draftablePlayerIds.length === 0 || exponent <= 1) {
    return out;
  }
  let weightSum = 0;
  const weights = new Map<string, number>();
  for (const id of draftablePlayerIds) {
    const sb = surplusBasisById.get(id) ?? 0;
    const baseline = baselineById.get(id) ?? 0;
    if (sb <= 0 && baseline <= 0) continue;
    const core = Math.max(0.01, sb) * Math.max(0.01, baseline);
    const w = Math.pow(core, exponent);
    weights.set(id, w);
    weightSum += w;
  }
  if (weightSum <= 0) return out;
  for (const [id, w] of weights) {
    out.set(id, (surplusCash * w) / weightSum);
  }
  return out;
}
