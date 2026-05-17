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

export function slotCurrentMin(slotValues: Map<string, number[]>, s: string): number {
  const arr = slotValues.get(s);
  if (!arr || arr.length === 0) return 0;
  return Math.min(...arr);
}

export function replacementForSlotKey(
  repl: Record<string, number>,
  slot: string
): number {
  return repl[slot] ?? repl[slot.toUpperCase()] ?? 0;
}

/**
 * Best marginal score for one candidate against current demand (same objective as greedy assign).
 */
export function bestMarginalSlotPick(
  p: SlotAssignmentCandidate,
  demand: Map<string, number>,
  slotValues: Map<string, number[]>,
  rosterSlotKeys: ReadonlySet<string>,
  rosteredReplFloor: Record<string, number>,
  replPoolFloor: Record<string, number> = {},
  options?: { deterministic?: boolean; seed?: number }
): {
  score: number;
  slot: string;
  marginalReplacement: number;
} | null {
  const det = Boolean(options?.deterministic);
  let bestSlot: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestMarginal = 0;
  let bestTie = Number.POSITIVE_INFINITY;
  let bestId = "";

  for (const s of demand.keys()) {
    const need = demand.get(s) ?? 0;
    if (need <= 0) continue;
    if (!fitsRosterSlot(s, p.tokens)) continue;
    const smin = slotCurrentMin(slotValues, s);
    const marginalReplacement = Math.max(
      smin,
      replacementForSlotKey(rosteredReplFloor, s),
      replacementForSlotKey(replPoolFloor, s)
    );
    const score = p.baseline - marginalReplacement;
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
      bestMarginal = marginalReplacement;
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
    if (bnSlot != null) {
      bestSlot = bnSlot;
      bestMarginal = slotCurrentMin(slotValues, bnSlot);
      bestScore = p.baseline - bestMarginal;
    }
  }

  if (bestSlot == null) return null;
  return { score: bestScore, slot: bestSlot, marginalReplacement: bestMarginal };
}

/** Marginal score for a single roster slot (used in slot-balanced undrafted fill). */
export function marginalScoreForSlot(
  p: SlotAssignmentCandidate,
  slotKey: string,
  demand: Map<string, number>,
  slotValues: Map<string, number[]>,
  rosteredReplFloor: Record<string, number>,
  replPoolFloor: Record<string, number> = {}
): { score: number; marginalReplacement: number } | null {
  if ((demand.get(slotKey) ?? 0) <= 0) return null;
  if (!fitsRosterSlot(slotKey, p.tokens)) return null;
  const marginalReplacement = Math.max(
    slotCurrentMin(slotValues, slotKey),
    replacementForSlotKey(rosteredReplFloor, slotKey),
    replacementForSlotKey(replPoolFloor, slotKey)
  );
  return {
    score: p.baseline - marginalReplacement,
    marginalReplacement,
  };
}

/** Assign one player to a specific slot (used when slot-balanced fill already chose the slot). */
export function assignCandidateToSlot(
  p: SlotAssignmentCandidate,
  slotKey: string,
  demand: Map<string, number>,
  slotValues: Map<string, number[]>,
  options?: {
    rosteredReplFloor?: Record<string, number>;
    replPoolFloor?: Record<string, number>;
    onAssign?: (
      playerId: string,
      slotKey: string,
      baseline: number,
      marginalReplacement: number
    ) => void;
  }
): boolean {
  const need = demand.get(slotKey) ?? 0;
  if (need <= 0) return false;
  if (!fitsRosterSlot(slotKey, p.tokens)) return false;
  const slotMin = slotCurrentMin(slotValues, slotKey);
  const marginalReplacement = Math.max(
    slotMin,
    replacementForSlotKey(options?.rosteredReplFloor ?? {}, slotKey),
    replacementForSlotKey(options?.replPoolFloor ?? {}, slotKey)
  );
  demand.set(slotKey, need - 1);
  const arr = slotValues.get(slotKey) ?? [];
  arr.push(p.baseline);
  slotValues.set(slotKey, arr);
  options?.onAssign?.(p.player_id, slotKey, p.baseline, marginalReplacement);
  return true;
}

export function greedyAssignLeagueSlotsMutable(
  sortedPlayers: SlotAssignmentCandidate[],
  demand: Map<string, number>,
  slotValues: Map<string, number[]>,
  rosterSlotKeys: ReadonlySet<string>,
  options?: {
    deterministic?: boolean;
    seed?: number;
    onAssign?: (
      playerId: string,
      slotKey: string,
      baseline: number,
      /** `min(assigned baselines at slot)` before this player was placed — marginal replacement for surplus. */
      marginalReplacement: number
    ) => void;
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

    const marginalReplacement = slotCurrentMin(slotValues, bestSlot);
    demand.set(bestSlot, (demand.get(bestSlot) ?? 0) - 1);
    const arr = slotValues.get(bestSlot) ?? [];
    arr.push(p.baseline);
    slotValues.set(bestSlot, arr);
    options?.onAssign?.(
      p.player_id,
      bestSlot,
      p.baseline,
      marginalReplacement
    );
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

/** Positional slots used for auction surplus (never BN / UTIL-as-fallback when specific fit exists). */
export const AUCTION_SURPLUS_SPECIFIC_SLOTS = new Set([
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "OF",
  "CI",
  "MI",
  "DH",
  "SP",
  "RP",
  "P",
]);

function normalizeSlotKey(slot: string): string {
  return slot.toUpperCase().trim();
}

function isSpecificAuctionSurplusSlot(slotKey: string): boolean {
  return AUCTION_SURPLUS_SPECIFIC_SLOTS.has(normalizeSlotKey(slotKey));
}

function replacementForSlot(
  repl: Record<string, number>,
  slot: string
): number {
  const key = normalizeSlotKey(slot);
  return repl[key] ?? repl[slot] ?? 0;
}

/**
 * Roster slots eligible for replacement_slots_v2 auction `surplus_basis`.
 * BN is never used. UTIL is used only when no specific active slot (C/1B/…/P) fits.
 */
function filterCompositeSurplusSlots(
  slots: string[],
  tokens: readonly string[]
): string[] {
  const normalized = new Set(slots.map((s) => normalizeSlotKey(s)));
  const has1B =
    normalized.has("1B") && fitsRosterSlot("1B", tokens);
  const has3B =
    normalized.has("3B") && fitsRosterSlot("3B", tokens);
  const has2B =
    normalized.has("2B") && fitsRosterSlot("2B", tokens);
  const hasSS =
    normalized.has("SS") && fitsRosterSlot("SS", tokens);
  return slots.filter((s) => {
    const key = normalizeSlotKey(s);
    if (key === "CI" && (has1B || has3B)) return false;
    if (key === "MI" && (has2B || hasSS)) return false;
    return true;
  });
}

export function eligibleAuctionSurplusSlots(
  tokens: readonly string[],
  rosterSlotKeys: ReadonlySet<string>
): string[] {
  const eligible: string[] = [];
  for (const slot of rosterSlotKeys) {
    if (normalizeSlotKey(slot) === "BN") continue;
    if (!fitsRosterSlot(slot, tokens)) continue;
    eligible.push(slot);
  }

  const specific = filterCompositeSurplusSlots(
    eligible.filter((s) => isSpecificAuctionSurplusSlot(s)),
    tokens,
  );
  if (specific.length > 0) return specific;

  const withoutUtil = eligible.filter((s) => normalizeSlotKey(s) !== "UTIL");
  if (withoutUtil.length > 0) return withoutUtil;

  return eligible.filter((s) => normalizeSlotKey(s) === "UTIL");
}

export function maxSurplusOverSlots(
  baseline: number,
  tokens: readonly string[],
  repl: Record<string, number>,
  rosterSlotKeys: ReadonlySet<string>
): number {
  let best = 0;
  for (const slot of eligibleAuctionSurplusSlots(tokens, rosterSlotKeys)) {
    const r = replacementForSlot(repl, slot);
    best = Math.max(best, baseline - r);
  }
  return Math.max(0, best);
}

/** Best positional surplus slot for explain / surplus_basis (never BN; UTIL only if sole fit). */
export function bestAuctionSurplusSlot(
  baseline: number,
  tokens: readonly string[],
  repl: Record<string, number>,
  rosterSlotKeys: ReadonlySet<string>
): { slot: string; replacement: number; surplus: number } | null {
  let best: { slot: string; replacement: number; surplus: number } | null = null;
  for (const slot of eligibleAuctionSurplusSlots(tokens, rosterSlotKeys)) {
    const replacement = replacementForSlot(repl, slot);
    const surplus = Math.max(0, baseline - replacement);
    if (!best || surplus > best.surplus + 1e-9) {
      best = { slot, replacement, surplus };
    }
  }
  return best;
}
