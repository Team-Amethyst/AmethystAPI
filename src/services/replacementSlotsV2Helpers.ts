import { getPlayerId } from "../lib/playerId";
import {
  fitsRosterSlot,
  maxSurplusOverSlots,
  playerTokensFromDrafted,
  playerTokensFromLean,
  replacementForSlotKey,
  type PositionOverrideMap,
  type SlotAssignmentCandidate,
} from "../lib/fantasyRosterSlots";
import {
  DEFAULT_HYBRID_SURPLUS_CALIBRATION,
  HYBRID_SURPLUS_CORE,
  type HybridSurplusCalibration,
  HYBRID_SURPLUS_BASELINE_PERCENTILE,
  HYBRID_SURPLUS_SLOT_BELOW_PERCENTILE,
  SLOT_REPLACEMENT_DEFAULT_PERCENTILE,
} from "./replacementSlotsV2Config";
import type { DraftedPlayer, LeanPlayer } from "../types/brain";
import { compareSlotAssignmentCandidates } from "./replacementSlotsV2Compare";
import { AUCTION_SURPLUS_SPECIFIC_SLOTS } from "../lib/fantasySlotAssignment";

const PITCHER_REPL_KEYS = new Set(["SP", "RP", "P"]);

function isPitcherReplKey(key: string): boolean {
  return PITCHER_REPL_KEYS.has(key.toUpperCase());
}

/** When UTIL had no greedy fill, floor at max hitter replacement (never 0 for surplus). */
export function imputeUtilReplacementFloor(
  repl: Record<string, number>,
  rosterSlotKeys: ReadonlySet<string>
): Record<string, number> {
  const out = { ...repl };
  let utilKey: string | undefined;
  for (const k of rosterSlotKeys) {
    if (k.toUpperCase() === "UTIL") utilKey = k;
  }
  if (utilKey == null || (out[utilKey] ?? 0) > 0) return out;

  let maxHitter = 0;
  for (const [key, val] of Object.entries(out)) {
    const ku = key.toUpperCase();
    if (ku === "BN" || ku === "UTIL") continue;
    if (isPitcherReplKey(ku)) continue;
    if (!AUCTION_SURPLUS_SPECIFIC_SLOTS.has(ku)) continue;
    if (typeof val === "number" && val > maxHitter) maxHitter = val;
  }
  if (maxHitter > 0) out[utilKey] = maxHitter;
  return out;
}

/**
 * Greedy fill may leave a slot with no assigned baselines → percentile 0.
 * Floor empty active slots at the median positive replacement in their bucket (hitters vs pitchers).
 */
export function imputeEmptySlotReplacementFloors(
  repl: Record<string, number>,
  rosterSlotKeys: ReadonlySet<string>
): Record<string, number> {
  const out = { ...repl };
  const hitterVals: number[] = [];
  const pitcherVals: number[] = [];
  for (const [key, val] of Object.entries(out)) {
    const ku = key.toUpperCase();
    if (ku === "BN" || ku === "UTIL" || typeof val !== "number" || val <= 0) continue;
    if (isPitcherReplKey(ku)) pitcherVals.push(val);
    else hitterVals.push(val);
  }
  const hitterFloor =
    hitterVals.length > 0
      ? hitterVals.sort((a, b) => a - b)[Math.floor(hitterVals.length / 2)]!
      : 0;
  const pitcherFloor =
    pitcherVals.length > 0
      ? pitcherVals.sort((a, b) => a - b)[Math.floor(pitcherVals.length / 2)]!
      : 0;

  for (const key of rosterSlotKeys) {
    const ku = key.toUpperCase();
    if (ku === "BN" || (out[key] ?? 0) > 0) continue;
    if (isPitcherReplKey(ku)) {
      if (pitcherFloor > 0) out[key] = pitcherFloor;
    } else if (ku !== "UTIL" && hitterFloor > 0) {
      out[key] = hitterFloor;
    }
  }
  return out;
}

/** Post-process replacement floors for auction surplus (UTIL + empty slots). */
export function finalizeReplacementValuesForSurplus(
  repl: Record<string, number>,
  rosterSlotKeys: ReadonlySet<string>
): Record<string, number> {
  return imputeEmptySlotReplacementFloors(
    imputeUtilReplacementFloor(repl, rosterSlotKeys),
    rosterSlotKeys
  );
}

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

function percentileFromValues(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const p = Math.max(0, Math.min(1, percentile));
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.round((sorted.length - 1) * p);
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))] ?? 0;
}

/**
 * Per-slot replacement floor from the undrafted pool (before greedy fill).
 * Stops empty-slot marginalReplacement=0 from treating the first assignee as full baseline surplus.
 */
export function buildUndraftedPoolReplacementFloors(
  candidates: SlotAssignmentCandidate[],
  rosterSlotKeys: ReadonlySet<string>,
  percentileBySlot: Record<string, number>,
  defaultPercentile = SLOT_REPLACEMENT_DEFAULT_PERCENTILE
): Record<string, number> {
  const bySlot = new Map<string, number[]>();
  for (const c of candidates) {
    for (const slot of rosterSlotKeys) {
      const ku = slot.toUpperCase();
      if (ku === "BN") continue;
      if (!fitsRosterSlot(slot, c.tokens)) continue;
      const arr = bySlot.get(slot) ?? [];
      arr.push(c.baseline);
      bySlot.set(slot, arr);
    }
  }
  const out: Record<string, number> = {};
  for (const slot of rosterSlotKeys) {
    const ku = slot.toUpperCase();
    if (ku === "BN") continue;
    const arr = bySlot.get(slot) ?? [];
    const p = percentileBySlot[ku] ?? percentileBySlot[slot] ?? defaultPercentile;
    out[slot] = percentileFromValues(arr, p);
  }
  return out;
}

export function effectiveMarginalReplacement(
  slotKey: string,
  slotMin: number,
  replAfterRostered: Record<string, number>,
  replPoolFloor: Record<string, number>
): number {
  return Math.max(
    slotMin,
    replAfterRostered[slotKey] ??
      replAfterRostered[slotKey.toUpperCase()] ??
      0,
    replPoolFloor[slotKey] ?? replPoolFloor[slotKey.toUpperCase()] ?? 0
  );
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

export type MarginalAssignmentSurplus = {
  slot: string;
  marginalReplacement: number;
  surplus: number;
};

export function marginalSurplusAtAssignment(
  baseline: number,
  marginalReplacement: number
): number {
  return Math.max(0, baseline - marginalReplacement);
}

/**
 * Surplus for a greedy draftable assignment. If the slot queue is already deep
 * (marginal surplus 0), fall back to pool-level positional floor (not post-fill percentile).
 */
export function surplusForDraftableAssignment(params: {
  baseline: number;
  tokens: readonly string[];
  slotKey: string;
  marginalReplacement: number;
  replAfterRostered: Record<string, number>;
  replPoolFloor: Record<string, number>;
  rosterSlotKeys: ReadonlySet<string>;
}): number {
  const effectiveMarginal = effectiveMarginalReplacement(
    params.slotKey,
    params.marginalReplacement,
    params.replAfterRostered,
    params.replPoolFloor
  );
  const poolLine = Math.max(
    params.replPoolFloor[params.slotKey] ??
      params.replPoolFloor[params.slotKey.toUpperCase()] ??
      0,
    replacementForSlotKey(params.replAfterRostered, params.slotKey)
  );
  const atAssign = marginalSurplusAtAssignment(
    params.baseline,
    effectiveMarginal
  );
  /** Slot queue saturated vs baseline — use pool/rostered line, not intra-slot min. */
  if (
    params.marginalReplacement > poolLine + 1e-6 &&
    params.baseline > poolLine + 1e-6
  ) {
    const saturatedSb = Math.max(0, params.baseline - poolLine);
    if (saturatedSb > atAssign) return saturatedSb;
  }
  if (atAssign > 0) return atAssign;
  return maxSurplusOverSlots(
    params.baseline,
    params.tokens,
    params.replPoolFloor,
    params.rosterSlotKeys
  );
}

export function computeTotalSurplusMassFromBasis(
  assignedIds: Set<string>,
  surplusBasisById: Map<string, number>
): number {
  let total = 0;
  for (const id of assignedIds) {
    total += surplusBasisById.get(id) ?? 0;
  }
  return total;
}

/** @deprecated Use computeTotalSurplusMassFromBasis after buildSurplusBasisMap. */
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

/**
 * Draftable players: surplus at greedy assignment (baseline − slot min before assign).
 * BN assignments and non-assigned rows: best specific-slot surplus (UTIL/BN excluded).
 */
function percentileFromSortedValues(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const p = Math.max(0, Math.min(1, percentile));
  const idx = Math.round((sorted.length - 1) * p);
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))] ?? 0;
}

/**
 * Lift draftable `surplus_basis` for elite baselines assigned into saturated slots.
 * Preserves total surplus mass (renormalize) so inflation_factor stays budget-consistent.
 */
function tokensIncludeHitterSlot(tokens: readonly string[]): boolean {
  for (const t of tokens) {
    const u = t.toUpperCase();
    if (isPitcherReplKey(u) || u === "P") continue;
    return true;
  }
  return false;
}

function smoothGateWeight(
  baseline: number,
  gateMin: number,
  rampSpan: number
): number {
  if (baseline <= gateMin + 1e-9) return 0;
  const t = Math.min(1, (baseline - gateMin) / Math.max(rampSpan, 1e-6));
  return t * t * (3 - 2 * t);
}

export type HybridSurplusApplyResult = {
  surplusBasisById: Map<string, number>;
  hybridLiftByPlayerId: Map<string, number>;
};

export function applyHybridDraftableSurplusBasis(params: {
  surplusBasisById: Map<string, number>;
  assignedIds: Set<string>;
  baselineById: Map<string, number>;
  targetTotalMass: number;
  /** Full undrafted pool baselines (for strength floor); defaults to assigned only. */
  strengthFloorBaselines?: readonly number[];
  playerTokensById?: Map<string, readonly string[]>;
  categoryProjectionById?: Map<string, number>;
  assignedSlotById?: Map<string, string>;
  calibration?: HybridSurplusCalibration;
}): HybridSurplusApplyResult {
  const cal: HybridSurplusCalibration = params.calibration
    ? { ...HYBRID_SURPLUS_CORE, ...params.calibration }
    : { ...HYBRID_SURPLUS_CORE, ...DEFAULT_HYBRID_SURPLUS_CALIBRATION };
  const {
    surplusBasisById,
    assignedIds,
    baselineById,
    targetTotalMass,
    playerTokensById,
    categoryProjectionById,
    assignedSlotById,
  } = params;
  const baselinePercentile =
    cal.baselinePercentile ?? HYBRID_SURPLUS_BASELINE_PERCENTILE;
  const strengthMultiplier = cal.strengthMultiplier;
  const slotBelowPercentile =
    cal.slotBelowPercentile ?? HYBRID_SURPLUS_SLOT_BELOW_PERCENTILE;

  const out = new Map(surplusBasisById);
  const hybridLiftByPlayerId = new Map<string, number>();
  if (assignedIds.size === 0 || targetTotalMass <= 0) {
    return { surplusBasisById: out, hybridLiftByPlayerId };
  }

  const assignedBaselines: number[] = [];
  const slotSbs: number[] = [];
  for (const id of assignedIds) {
    const b = baselineById.get(id) ?? 0;
    if (b > 0) assignedBaselines.push(b);
    slotSbs.push(surplusBasisById.get(id) ?? 0);
  }
  if (assignedBaselines.length === 0) {
    return { surplusBasisById: out, hybridLiftByPlayerId };
  }

  assignedBaselines.sort((a, b) => a - b);
  slotSbs.sort((a, b) => a - b);
  const floorSource = [...(params.strengthFloorBaselines ?? assignedBaselines)]
    .filter((b) => b > 0)
    .sort((a, b) => a - b);
  const strengthFloor = percentileFromSortedValues(
    floorSource.length > 0 ? floorSource : assignedBaselines,
    baselinePercentile
  );
  const slotMedian = percentileFromSortedValues(
    slotSbs,
    slotBelowPercentile
  );
  const scarceSlots = cal.scarceSlotsOnly?.map((s) => s.toUpperCase()) ?? [];
  const scarceSet = new Set(scarceSlots);

  for (const id of assignedIds) {
    const slotSb = surplusBasisById.get(id) ?? 0;
    if (slotSb >= slotMedian - 1e-9) continue;
    const tokens = playerTokensById?.get(id) ?? [];
    if (tokens.length > 0 && !tokensIncludeHitterSlot(tokens)) continue;
    const baseline = baselineById.get(id) ?? 0;
    const proj = categoryProjectionById?.get(id) ?? 0;
    if (cal.minCategoryProjection != null && proj < cal.minCategoryProjection - 1e-9) {
      continue;
    }
    const slot = (assignedSlotById?.get(id) ?? "").toUpperCase();
    if (scarceSet.size > 0 && !scarceSet.has(slot.toUpperCase())) continue;
    let effectiveGate = cal.eliteGateMin;
    if (
      scarceSet.size > 0 &&
      scarceSet.has(slot.toUpperCase()) &&
      cal.minCategoryProjection != null &&
      proj >= cal.minCategoryProjection - 1e-9 &&
      (cal.categoryStrongGateRelax ?? 0) > 0
    ) {
      effectiveGate = cal.eliteGateMin - (cal.categoryStrongGateRelax ?? 0);
    }
    const gateW =
      cal.gateMode === "smooth"
        ? smoothGateWeight(
            baseline,
            effectiveGate,
            cal.smoothRampSpan ?? 4
          )
        : baseline >= effectiveGate - 1e-9
          ? 1
          : 0;
    if (gateW <= 0) continue;
    const rawStrength = Math.max(0, baseline - strengthFloor) * strengthMultiplier;
    const strengthSb = Math.min(cal.hybridCap, rawStrength * gateW);
    if (strengthSb > slotSb + 1e-9) {
      out.set(id, strengthSb);
      hybridLiftByPlayerId.set(id, strengthSb - slotSb);
    }
  }
  return { surplusBasisById: out, hybridLiftByPlayerId };
}

export function buildSurplusBasisMap(
  undrafted: LeanPlayer[],
  replacementValues: Record<string, number>,
  rosterSlotKeys: ReadonlySet<string>,
  positionOverrides?: PositionOverrideMap,
  marginalByPlayerId?: Map<string, MarginalAssignmentSurplus>,
  assignedIds?: Set<string>,
  /** Pool-level floors for players outside the greedy draftable fill (avoids min-bid collapse). */
  replPoolFloor?: Record<string, number>
): Map<string, number> {
  const out = new Map<string, number>();
  const poolRepl = replPoolFloor ?? replacementValues;
  for (const p of undrafted) {
    const id = getPlayerId(p);
    const tokens = playerTokensFromLean(p, positionOverrides);
    const marginal = marginalByPlayerId?.get(id);
    const useMarginal =
      assignedIds?.has(id) &&
      marginal != null &&
      marginal.slot.toUpperCase() !== "BN";
    if (useMarginal) {
      out.set(id, marginal.surplus);
    } else {
      out.set(
        id,
        maxSurplusOverSlots(
          p.value || 0,
          tokens,
          poolRepl,
          rosterSlotKeys
        )
      );
    }
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
