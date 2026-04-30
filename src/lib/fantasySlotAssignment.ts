import type { RosterSlot } from "../types/brain";
import { fitsRosterSlot, slotSpecificityIndex } from "./fantasyPositioning";

export type SlotAssignmentCandidate = {
  player_id: string;
  baseline: number;
  tokens: string[];
};

export function buildLeagueSlotDemand(
  rosterSlots: RosterSlot[],
  numTeams: number
): Map<string, number> {
  const m = new Map<string, number>();
  for (const rs of rosterSlots) {
    const k = rs.position.toUpperCase().trim();
    if (!k) continue;
    const c = Math.max(0, Math.floor(rs.count ?? 0)) * Math.max(1, numTeams);
    m.set(k, (m.get(k) ?? 0) + c);
  }
  return m;
}

export function cloneDemandMap(d: Map<string, number>): Map<string, number> {
  return new Map(d);
}

export function sumDemand(d: Map<string, number>): number {
  let s = 0;
  for (const v of d.values()) s += v;
  return s;
}

function slotCurrentMin(slotValues: Map<string, number[]>, s: string): number {
  const arr = slotValues.get(s);
  if (!arr || arr.length === 0) return 0;
  return Math.min(...arr);
}

export function greedyAssignLeagueSlotsMutable(
  sortedPlayers: SlotAssignmentCandidate[],
  demand: Map<string, number>,
  slotValues: Map<string, number[]>,
  rosterSlotKeys: ReadonlySet<string>,
  options?: {
    deterministic?: boolean;
    seed?: number;
    onAssign?: (playerId: string, slotKey: string, baseline: number) => void;
  }
): void {
  const det = Boolean(options?.deterministic);

  for (const p of sortedPlayers) {
    let bestSlot: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestTie = Number.POSITIVE_INFINITY;
    let bestId = "";

    for (const s of demand.keys()) {
      const need = demand.get(s) ?? 0;
      if (need <= 0) continue;
      if (!fitsRosterSlot(s, p.tokens)) continue;
      const smin = slotCurrentMin(slotValues, s);
      const score = p.baseline - smin;
      const tie = slotSpecificityIndex(s, rosterSlotKeys);
      const idTie =
        det && Math.abs(score - bestScore) < 1e-9 && tie === bestTie
          ? p.player_id.localeCompare(bestId)
          : 0;
      if (
        score > bestScore + 1e-9 ||
        (Math.abs(score - bestScore) < 1e-9 &&
          (tie < bestTie || (tie === bestTie && idTie < 0)))
      ) {
        bestScore = score;
        bestSlot = s;
        bestTie = tie;
        bestId = p.player_id;
      }
    }

    if (bestSlot == null) {
      let bnTie = Number.POSITIVE_INFINITY;
      let bnSlot: string | null = null;
      for (const s of demand.keys()) {
        const need = demand.get(s) ?? 0;
        if (need <= 0) continue;
        if (s.toUpperCase() !== "BN") continue;
        const tie = slotSpecificityIndex(s, rosterSlotKeys);
        if (tie < bnTie) {
          bnTie = tie;
          bnSlot = s;
        }
      }
      if (bnSlot != null) bestSlot = bnSlot;
    }

    if (bestSlot == null) continue;

    demand.set(bestSlot, (demand.get(bestSlot) ?? 0) - 1);
    const arr = slotValues.get(bestSlot) ?? [];
    arr.push(p.baseline);
    slotValues.set(bestSlot, arr);
    options?.onAssign?.(p.player_id, bestSlot, p.baseline);
  }
}

export function greedyAssignLeagueSlots(
  sortedPlayers: SlotAssignmentCandidate[],
  demand: Map<string, number>,
  rosterSlotKeys: ReadonlySet<string>,
  options?: { deterministic?: boolean; seed?: number }
): Map<string, number[]> {
  const slotValues = new Map<string, number[]>();
  const dem = cloneDemandMap(demand);
  greedyAssignLeagueSlotsMutable(
    sortedPlayers,
    dem,
    slotValues,
    rosterSlotKeys,
    options
  );
  return slotValues;
}

export function replacementLevelsFromSlotValues(
  slotValues: Map<string, number[]>,
  rosterSlotKeys: ReadonlySet<string>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of rosterSlotKeys) {
    const arr = slotValues.get(k);
    out[k] = arr && arr.length > 0 ? Math.min(...arr) : 0;
  }
  return out;
}

function percentileFromValues(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const p = Math.max(0, Math.min(1, percentile));
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.round((sorted.length - 1) * p);
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))] ?? 0;
}

export function replacementLevelsFromSlotValuesPercentile(
  slotValues: Map<string, number[]>,
  rosterSlotKeys: ReadonlySet<string>,
  percentileBySlot: Record<string, number>,
  defaultPercentile = 0.65
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of rosterSlotKeys) {
    const arr = slotValues.get(key) ?? [];
    const p = percentileBySlot[key] ?? defaultPercentile;
    out[key] = percentileFromValues(arr, p);
  }
  return out;
}

export function maxSurplusOverSlots(
  baseline: number,
  tokens: readonly string[],
  repl: Record<string, number>,
  rosterSlotKeys: ReadonlySet<string>
): number {
  let best = 0;
  for (const slot of rosterSlotKeys) {
    if (!fitsRosterSlot(slot, tokens)) continue;
    const r = repl[slot] ?? 0;
    best = Math.max(best, baseline - r);
  }
  return Math.max(0, best);
}
