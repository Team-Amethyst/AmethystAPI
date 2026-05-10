import type {
  LeanPlayer,
  RosterSlot,
  ScoringCategory,
  ScoringFormat,
} from "../types/brain";
import type { BaselineRiskExplainFields } from "../types/baselineRiskExplain";
import {
  fitsRosterSlot,
  playerTokensFromLean,
  type PositionOverrideMap,
} from "../lib/fantasyRosterSlots";
import { catalogValuePrior } from "../lib/catalogValuePrior";
import {
  categoryDirection,
  categoryRawValue,
  categoryWeight,
  getProjectionSection,
  isPitcherForBaseline,
  isTwoWayEligibleForBaseline,
  mean,
  pointsCategoryRaw,
  stdDev,
} from "./baselineProjectionStats";
import { applyBaselineRiskChain } from "./baselineRiskChain";
import { ROTO_Z_HITTER, ROTO_Z_PITCHER } from "./baselineRotoZConfig";

/** Catalog dollar prior weight in rotisserie baselines (remainder is projection-driven). */
const ROTO_CATALOG_PRIOR_WEIGHT = 0.12;
/** Intrinsic dollar scale before scarcity when stats are neutral (not Mongo dollars). */
const ROTO_INTRINSIC_BASE_HITTER = 24;
/**
 * Pitcher intrinsic rotisserie baseline anchor (`statCore = intrinsic * projectionMult × …`).
 * Wrapped so offline calibration scripts can sweep without editing literals.
 *
 * **May 2026:** Raised **+3** after canonical catalog cleanup — pairs with `ROTO_Z_PITCHER.zHi`
 * so standard mixed auction dollars shift toward realistic hitter/pitcher balance (~70%/30% vs
 * prior hitter-heavy boards). Generic **P** slots and thin eligible pools remain stress cases;
 * see scenario-matrix audit scripts under `scripts/pitcher-balance-scenario-matrix.ts`.
 */
export const ROTO_INTRINSIC_BASE_PITCHER_REF = { value: 23 };

function defaultPointsWeight(cat: ScoringCategory): number {
  const k = cat.name.toUpperCase();
  if (cat.type === "batting") {
    if (k === "HR") return 4;
    if (k === "R" || k === "RBI") return 1;
    if (k === "SB") return 2;
    if (k === "AVG") return 120;
    if (k === "OBP") return 105;
    return 0.85;
  }
  if (k === "K") return 1;
  if (k === "W") return 6;
  if (k === "SV") return 5;
  if (k === "QS") return 4;
  if (k === "ERA") return -4;
  if (k === "WHIP") return -6;
  return 0.85;
}

type BaselineComponents = {
  value: number;
  projectionComponent: number;
  scarcityComponent: number;
  ageDepthComponent?: number;
  injuryComponent?: number;
  riskExplain: BaselineRiskExplainFields;
};

type RotoGroupKind = "hitter" | "pitcher";

type TwoWayBaselineExplainFields = {
  two_way_role_selected: "hitter" | "pitcher";
  hitter_baseline_candidate: number;
  pitcher_baseline_candidate: number;
};

function computeTwoWayExplainFields(
  hitterCandidate: number,
  pitcherCandidate: number
): TwoWayBaselineExplainFields {
  const preferHitter = hitterCandidate >= pitcherCandidate;
  return {
    two_way_role_selected: preferHitter ? "hitter" : "pitcher",
    hitter_baseline_candidate: Number(hitterCandidate.toFixed(2)),
    pitcher_baseline_candidate: Number(pitcherCandidate.toFixed(2)),
  };
}

/**
 * When catalog dollars are tiny but catalog rank/tier still show real draft interest,
 * lift baseline slightly so late picks and spec arms are not all $1 anchors.
 */
function speculativePriorBaselineFloor(p: LeanPlayer): number | null {
  const catalog = catalogValuePrior(p);
  if (catalog >= 4) return null;
  const cr =
    typeof p.catalog_rank === "number" && Number.isFinite(p.catalog_rank) && p.catalog_rank > 0
      ? p.catalog_rank
      : null;
  const tier =
    typeof p.catalog_tier === "number" && Number.isFinite(p.catalog_tier)
      ? p.catalog_tier
      : null;
  if (cr == null || cr > 200) return null;
  if (tier == null || tier > 4) return null;
  const fromCatalogRank = 2.4 + (200 - cr) * 0.034;
  const fromTier = (5 - tier) * 0.85;
  return Math.min(15, fromCatalogRank + fromTier);
}

function scarcityMultiplierForPosition(
  p: LeanPlayer,
  rosterSlots: RosterSlot[],
  overrides?: PositionOverrideMap
): number {
  if (rosterSlots.length === 0) return 1;
  const tokens = playerTokensFromLean(p, overrides);
  let demand = 1;
  for (const slot of rosterSlots) {
    const key = slot.position.toUpperCase().trim();
    if (key === "BN" || key.length === 0) continue;
    if (fitsRosterSlot(key, tokens)) {
      demand = Math.max(demand, slot.count);
    }
  }
  const bounded = Math.min(1.25, 1 + (demand - 1) * 0.05);
  return Number(bounded.toFixed(4));
}

function rotoBaselineForGroup(
  group: LeanPlayer[],
  categories: ScoringCategory[],
  rosterSlots: RosterSlot[],
  groupKind: RotoGroupKind,
  positionOverrides?: PositionOverrideMap
): Map<string, BaselineComponents> {
  const out = new Map<string, BaselineComponents>();
  if (group.length === 0) return out;
  const projectionSectionKey = groupKind === "pitcher" ? "pitching" : "batting";
  const isPitcherSide = groupKind === "pitcher";
  if (categories.length === 0) {
    for (const p of group) {
      const scarcityComponent =
        scarcityMultiplierForPosition(p, rosterSlots, positionOverrides) - 1;
      const intrinsicBase =
        groupKind === "pitcher"
          ? ROTO_INTRINSIC_BASE_PITCHER_REF.value
          : ROTO_INTRINSIC_BASE_HITTER;
      const blendedCore =
        intrinsicBase * (1 - ROTO_CATALOG_PRIOR_WEIGHT) +
        Math.max(0, catalogValuePrior(p)) * ROTO_CATALOG_PRIOR_WEIGHT;
      let baseValue = Math.max(1, blendedCore * (1 + scarcityComponent));
      const priorFloor = speculativePriorBaselineFloor(p);
      if (priorFloor != null) baseValue = Math.max(baseValue, priorFloor);
      const risk = applyBaselineRiskChain({
        player: p,
        baselineValue: baseValue,
        isPitcher: isPitcherSide,
      });
      out.set(String(p._id), {
        value: Number(risk.adjustedValue.toFixed(2)),
        projectionComponent: 0,
        scarcityComponent,
        ageDepthComponent: risk.ageDepthComponent,
        injuryComponent: risk.injuryComponent,
        riskExplain: risk.riskExplain,
      });
    }
    return out;
  }

  const catStats = categories.map((cat) => {
    const vals = group.map((p) =>
      categoryRawValue(getProjectionSection(p, projectionSectionKey), cat.name)
    );
    return {
      cat,
      avg: mean(vals),
      stdev: stdDev(vals),
    };
  });

  for (const p of group) {
    const section = getProjectionSection(p, projectionSectionKey);
    let zWeighted = 0;
    for (const c of catStats) {
      const raw = categoryRawValue(section, c.cat.name);
      if (c.stdev <= 1e-9) continue;
      let z = (raw - c.avg) / c.stdev;
      if (categoryDirection(c.cat.name) === "lower") z = -z;
      zWeighted += z * categoryWeight(c.cat.name);
    }

    const zScale = groupKind === "pitcher" ? ROTO_Z_PITCHER.zScale : ROTO_Z_HITTER.zScale;
    const zLo = groupKind === "pitcher" ? ROTO_Z_PITCHER.zLo : ROTO_Z_HITTER.zLo;
    const zHi = groupKind === "pitcher" ? ROTO_Z_PITCHER.zHi : ROTO_Z_HITTER.zHi;
    const projectionMult = Math.max(zLo, Math.min(zHi, 1 + zWeighted * zScale));
    const scarcityComponent =
      scarcityMultiplierForPosition(p, rosterSlots, positionOverrides) - 1;
    const intrinsicBase =
      groupKind === "pitcher"
        ? ROTO_INTRINSIC_BASE_PITCHER_REF.value
        : ROTO_INTRINSIC_BASE_HITTER;
    const statCore = intrinsicBase * projectionMult;
    const prior = catalogValuePrior(p);
    const blendedCore =
      statCore * (1 - ROTO_CATALOG_PRIOR_WEIGHT) +
      Math.max(0, prior) * ROTO_CATALOG_PRIOR_WEIGHT;
    let value = Math.max(1, blendedCore * (1 + scarcityComponent));
    const priorFloor = speculativePriorBaselineFloor(p);
    if (priorFloor != null) value = Math.max(value, priorFloor);
    const risk = applyBaselineRiskChain({
      player: p,
      baselineValue: value,
      isPitcher: isPitcherSide,
    });
    out.set(String(p._id), {
      value: Number(risk.adjustedValue.toFixed(2)),
      projectionComponent: Number(
        (statCore * (1 + scarcityComponent) * (1 - ROTO_CATALOG_PRIOR_WEIGHT)).toFixed(2)
      ),
      scarcityComponent,
      ageDepthComponent: risk.ageDepthComponent,
      injuryComponent: risk.injuryComponent,
      riskExplain: risk.riskExplain,
    });
  }
  return out;
}

function rotisserieBaseline(
  p: LeanPlayer,
  rosterSlots: RosterSlot[],
  positionOverrides?: PositionOverrideMap
): {
  value: number;
  projectionComponent: number;
  scarcityComponent: number;
  ageDepthComponent?: number;
  injuryComponent?: number;
  riskExplain: BaselineRiskExplainFields;
} {
  const scarcityComponent =
    scarcityMultiplierForPosition(p, rosterSlots, positionOverrides) - 1;
  const prior = catalogValuePrior(p);
  const intrinsicBase = isPitcherForBaseline(p, positionOverrides)
    ? ROTO_INTRINSIC_BASE_PITCHER_REF.value
    : ROTO_INTRINSIC_BASE_HITTER;
  const blendedCore =
    intrinsicBase * (1 - ROTO_CATALOG_PRIOR_WEIGHT) +
    Math.max(0, prior) * ROTO_CATALOG_PRIOR_WEIGHT;
  const scarcityAdjusted = Math.max(1, blendedCore * (1 + scarcityComponent));
  const risk = applyBaselineRiskChain({
    player: p,
    baselineValue: scarcityAdjusted,
    isPitcher: isPitcherForBaseline(p, positionOverrides),
  });
  return {
    value: Number(risk.adjustedValue.toFixed(2)),
    projectionComponent: 0,
    scarcityComponent,
    ageDepthComponent: risk.ageDepthComponent,
    injuryComponent: risk.injuryComponent,
    riskExplain: risk.riskExplain,
  };
}

function pointsBaselineForSide(
  p: LeanPlayer,
  rosterSlots: RosterSlot[],
  scoringCategories: ScoringCategory[],
  positionOverrides: PositionOverrideMap | undefined,
  side: "hitter" | "pitcher"
): {
  value: number;
  projectionComponent: number;
  scarcityComponent: number;
  ageDepthComponent?: number;
  injuryComponent?: number;
  riskExplain: BaselineRiskExplainFields;
} {
  const batting = getProjectionSection(p, "batting");
  const pitching = getProjectionSection(p, "pitching");
  const scarcityComponent =
    scarcityMultiplierForPosition(p, rosterSlots, positionOverrides) - 1;

  let points = 0;
  for (const c of scoringCategories) {
    const w = defaultPointsWeight(c);
    if (side === "hitter" && c.type === "batting") {
      points += pointsCategoryRaw(batting, c.name) * w;
    } else if (side === "pitcher" && c.type === "pitching") {
      points += pointsCategoryRaw(pitching, c.name) * w;
    }
  }
  const projectionComponent = Math.max(0, points * 0.03);
  const prior = catalogValuePrior(p);
  const pointsDollars = Math.max(1, 8 + Math.max(0, points) * 0.042);
  const blendedCore =
    pointsDollars * (1 - ROTO_CATALOG_PRIOR_WEIGHT) +
    Math.max(0, prior) * ROTO_CATALOG_PRIOR_WEIGHT;
  let value = Math.max(1, blendedCore * (1 + scarcityComponent));
  const priorFloor = speculativePriorBaselineFloor(p);
  if (priorFloor != null) value = Math.max(value, priorFloor);
  const risk = applyBaselineRiskChain({
    player: p,
    baselineValue: value,
    isPitcher: side === "pitcher",
  });
  return {
    value: risk.adjustedValue,
    projectionComponent,
    scarcityComponent,
    ageDepthComponent: risk.ageDepthComponent,
    injuryComponent: risk.injuryComponent,
    riskExplain: risk.riskExplain,
  };
}

/** Points baseline for hitter-only or pitcher-only players. */
function pointsBaselineSingleRole(
  p: LeanPlayer,
  rosterSlots: RosterSlot[],
  scoringCategories: ScoringCategory[],
  positionOverrides?: PositionOverrideMap
): {
  value: number;
  projectionComponent: number;
  scarcityComponent: number;
  ageDepthComponent?: number;
  injuryComponent?: number;
  riskExplain: BaselineRiskExplainFields;
} {
  const side: "hitter" | "pitcher" = isPitcherForBaseline(p, positionOverrides)
    ? "pitcher"
    : "hitter";
  return pointsBaselineForSide(
    p,
    rosterSlots,
    scoringCategories,
    positionOverrides,
    side
  );
}

export function scoringAwareBaselinePlayers(
  players: LeanPlayer[],
  scoringFormat: ScoringFormat | undefined,
  scoringCategories: ScoringCategory[],
  rosterSlots: RosterSlot[],
  positionOverrides?: PositionOverrideMap
): LeanPlayer[] {
  const fmt = scoringFormat ?? "5x5";
  const rotoMap = new Map<string, BaselineComponents>();
  const twoWayExplainById = new Map<string, TwoWayBaselineExplainFields>();

  if (fmt !== "points") {
    const hitterCats = scoringCategories.filter((c) => c.type === "batting");
    const pitcherCats = scoringCategories.filter((c) => c.type === "pitching");
    const hitterPool = players.filter(
      (p) =>
        !isPitcherForBaseline(p, positionOverrides) ||
        isTwoWayEligibleForBaseline(p, positionOverrides)
    );
    const pitcherPool = players.filter(
      (p) =>
        isPitcherForBaseline(p, positionOverrides) ||
        isTwoWayEligibleForBaseline(p, positionOverrides)
    );
    const hitterMap = rotoBaselineForGroup(
      hitterPool,
      hitterCats,
      rosterSlots,
      "hitter",
      positionOverrides
    );
    const pitcherMap = rotoBaselineForGroup(
      pitcherPool,
      pitcherCats,
      rosterSlots,
      "pitcher",
      positionOverrides
    );

    for (const p of players) {
      if (!isTwoWayEligibleForBaseline(p, positionOverrides)) continue;
      const id = String(p._id);
      const hComp = hitterMap.get(id);
      const pComp = pitcherMap.get(id);
      if (hComp == null || pComp == null) continue;
      twoWayExplainById.set(
        id,
        computeTwoWayExplainFields(hComp.value, pComp.value)
      );
    }

    for (const p of players) {
      const id = String(p._id);
      if (isTwoWayEligibleForBaseline(p, positionOverrides)) {
        const hComp = hitterMap.get(id);
        const pComp = pitcherMap.get(id);
        if (hComp != null && pComp != null) {
          rotoMap.set(id, hComp.value >= pComp.value ? hComp : pComp);
        }
      } else if (!isPitcherForBaseline(p, positionOverrides)) {
        const hComp = hitterMap.get(id);
        if (hComp != null) rotoMap.set(id, hComp);
      } else {
        const pComp = pitcherMap.get(id);
        if (pComp != null) rotoMap.set(id, pComp);
      }
    }
  }

  return players.map((p) => {
    let derived: {
      value: number;
      projectionComponent: number;
      scarcityComponent: number;
      ageDepthComponent?: number;
      injuryComponent?: number;
      riskExplain: BaselineRiskExplainFields;
    };
    let twoWayExplain: TwoWayBaselineExplainFields | undefined;

    if (fmt === "points") {
      if (isTwoWayEligibleForBaseline(p, positionOverrides)) {
        const hCand = pointsBaselineForSide(
          p,
          rosterSlots,
          scoringCategories,
          positionOverrides,
          "hitter"
        );
        const pCand = pointsBaselineForSide(
          p,
          rosterSlots,
          scoringCategories,
          positionOverrides,
          "pitcher"
        );
        twoWayExplain = computeTwoWayExplainFields(hCand.value, pCand.value);
        derived = hCand.value >= pCand.value ? hCand : pCand;
      } else {
        derived = pointsBaselineSingleRole(
          p,
          rosterSlots,
          scoringCategories,
          positionOverrides
        );
      }
    } else {
      twoWayExplain = twoWayExplainById.get(String(p._id));
      derived =
        rotoMap.get(String(p._id)) ??
        rotisserieBaseline(p, rosterSlots, positionOverrides);
    }

    const baselineComponents = {
      scoring_format: fmt,
      projection_component: Number(derived.projectionComponent.toFixed(2)),
      scarcity_component: Number(derived.scarcityComponent.toFixed(4)),
      ...(derived.ageDepthComponent != null
        ? {
            age_depth_component: Number(derived.ageDepthComponent.toFixed(2)),
          }
        : {}),
      ...(derived.injuryComponent != null
        ? {
            injury_component: Number(derived.injuryComponent.toFixed(2)),
          }
        : {}),
      ...derived.riskExplain,
      ...(twoWayExplain ?? {}),
    };
    return {
      ...p,
      value: Number(derived.value.toFixed(2)),
      projection: {
        ...(p.projection ?? {}),
        __valuation_meta__: baselineComponents,
      },
    };
  });
}
