import type { DraftedPlayer, LeanPlayer, RosterSlot } from "../types/brain";

/** More specific roster slots win tie-breaks when surplus vs empty slot is equal. */
export const SLOT_SPECIFICITY_ORDER: readonly string[] = [
  "C",
  "SS",
  "2B",
  "3B",
  "1B",
  "CI",
  "MI",
  "OF",
  "SP",
  "RP",
  "P",
  "DH",
  "UTIL",
  "BN",
];

const HITTER_PRIMARIES = new Set([
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "OF",
  "DH",
  "CI",
  "MI",
]);

function normalizePositionToken(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (t === "LF" || t === "CF" || t === "RF") return "OF";
  return t;
}

export function tokenizeFantasyPositions(
  primary: string,
  extra?: readonly string[] | undefined
): string[] {
  const parts = [primary, ...(extra ?? [])].join(",").split(/[,/|]/);
  const out = new Set<string>();
  for (const p of parts) {
    const t = normalizePositionToken(p);
    if (t.length > 0) out.add(t);
  }
  return [...out];
}

export function playerTokensFromLean(p: LeanPlayer): string[] {
  return tokenizeFantasyPositions(p.position, undefined);
}

export function playerTokensFromDrafted(dp: DraftedPlayer): string[] {
  return tokenizeFantasyPositions(dp.position, dp.positions);
}

export function isHitter(tokens: readonly string[]): boolean {
  for (const t of tokens) {
    if (HITTER_PRIMARIES.has(t)) return true;
  }
  return false;
}

export function isPurePitcher(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  for (const t of tokens) {
    if (t !== "SP" && t !== "RP" && t !== "P") return false;
  }
  return true;
}

/**
 * Whether `tokens` can fill a roster slot label from `roster_slots`.
 * UTIL = hitters only. BN accepts anyone. CI / MI / P flex rules applied.
 */
export function fitsRosterSlot(slotKey: string, tokens: readonly string[]): boolean {
  const slot = slotKey.toUpperCase().trim();
  if (slot.length === 0) return false;
  if (slot === "BN") return true;
  if (slot === "UTIL") return isHitter(tokens);
  if (slot === "CI") return tokens.includes("1B") || tokens.includes("3B");
  if (slot === "MI") return tokens.includes("2B") || tokens.includes("SS");
  if (slot === "P") return tokens.includes("SP") || tokens.includes("RP") || tokens.includes("P");
  if (slot === "SP") return tokens.includes("SP");
  if (slot === "RP") return tokens.includes("RP");
  return tokens.includes(slot);
}

export function slotSpecificityIndex(
  slotKey: string,
  rosterSlotKeys: ReadonlySet<string>
): number {
  const u = slotKey.toUpperCase();
  const idx = SLOT_SPECIFICITY_ORDER.indexOf(u);
  if (idx !== -1) return idx;
  if (rosterSlotKeys.has(u)) return SLOT_SPECIFICITY_ORDER.length + u.charCodeAt(0);
  return 900 + u.charCodeAt(0);
}

/** League-wide slot demand: each roster row × num_teams. */
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

export type SlotAssignmentCandidate = {
  player_id: string;
  baseline: number;
  tokens: string[];
};

function slotCurrentMin(slotValues: Map<string, number[]>, s: string): number {
  const arr = slotValues.get(s);
  if (!arr || arr.length === 0) return 0;
  return Math.min(...arr);
}

/**
 * Greedy league-wide slot fill: highest baseline first; each player picks the eligible
 * open slot with highest (baseline − current slot floor), tie → more specific slot.
 * Mutates `demand` and `slotValues`.
 */
export function greedyAssignLeagueSlotsMutable(
  sortedPlayers: SlotAssignmentCandidate[],
  demand: Map<string, number>,
  slotValues: Map<string, number[]>,
  rosterSlotKeys: ReadonlySet<string>,
  options?: { deterministic?: boolean; seed?: number }
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
    if (arr && arr.length > 0) {
      out[k] = Math.min(...arr);
    } else {
      out[k] = 0;
    }
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
