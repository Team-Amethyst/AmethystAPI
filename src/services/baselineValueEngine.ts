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
const ROTO_INTRINSIC_BASE_PITCHER = 20;

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

/**
 * When catalog dollars are tiny but ADP/tier still show real draft interest,
 * lift baseline slightly so late picks and spec arms are not all $1 anchors.
 */
function speculativePriorBaselineFloor(p: LeanPlayer): number | null {
  const catalog = catalogValuePrior(p);
  if (catalog >= 4) return null;
  const adp = typeof p.adp === "number" && Number.isFinite(p.adp) && p.adp > 0 ? p.adp : null;
  const tier = typeof p.tier === "number" && Number.isFinite(p.tier) ? p.tier : null;
  if (adp == null || adp > 200) return null;
  if (tier == null || tier > 4) return null;
  const fromAdp = 2.4 + (200 - adp) * 0.034;
  const fromTier = (5 - tier) * 0.85;
  return Math.min(15, fromAdp + fromTier);
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
  if (categories.length === 0) {
    for (const p of group) {
      const scarcityComponent =
        scarcityMultiplierForPosition(p, rosterSlots, positionOverrides) - 1;
      const intrinsicBase =
        groupKind === "pitcher"
          ? ROTO_INTRINSIC_BASE_PITCHER
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
        isPitcher: isPitcherForBaseline(p, positionOverrides),
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
      categoryRawValue(
        getProjectionSection(
          p,
          isPitcherForBaseline(p, positionOverrides) ? "pitching" : "batting"
        ),
        cat.name
      )
    );
    return {
      cat,
      avg: mean(vals),
      stdev: stdDev(vals),
    };
  });

  for (const p of group) {
    const section = getProjectionSection(
      p,
      isPitcherForBaseline(p, positionOverrides) ? "pitching" : "batting"
    );
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
        ? ROTO_INTRINSIC_BASE_PITCHER
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
      isPitcher: isPitcherForBaseline(p, positionOverrides),
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
    ? ROTO_INTRINSIC_BASE_PITCHER
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

function pointsBaseline(
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
  const batting = getProjectionSection(p, "batting");
  const pitching = getProjectionSection(p, "pitching");
  const scarcityComponent =
    scarcityMultiplierForPosition(p, rosterSlots, positionOverrides) - 1;

  let points = 0;
  for (const c of scoringCategories) {
    const w = defaultPointsWeight(c);
    if (c.type === "batting" && !isPitcherForBaseline(p, positionOverrides)) {
      points += pointsCategoryRaw(batting, c.name) * w;
    } else if (c.type === "pitching" && isPitcherForBaseline(p, positionOverrides)) {
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
    isPitcher: isPitcherForBaseline(p, positionOverrides),
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

export function scoringAwareBaselinePlayers(
  players: LeanPlayer[],
  scoringFormat: ScoringFormat | undefined,
  scoringCategories: ScoringCategory[],
  rosterSlots: RosterSlot[],
  positionOverrides?: PositionOverrideMap
): LeanPlayer[] {
  const fmt = scoringFormat ?? "5x5";
  let rotoMap = new Map<string, BaselineComponents>();
  if (fmt !== "points") {
    const hitterCats = scoringCategories.filter((c) => c.type === "batting");
    const pitcherCats = scoringCategories.filter((c) => c.type === "pitching");
    const hitters = players.filter((p) => !isPitcherForBaseline(p, positionOverrides));
    const pitchers = players.filter((p) => isPitcherForBaseline(p, positionOverrides));
    const hitterMap = rotoBaselineForGroup(
      hitters,
      hitterCats,
      rosterSlots,
      "hitter",
      positionOverrides
    );
    const pitcherMap = rotoBaselineForGroup(
      pitchers,
      pitcherCats,
      rosterSlots,
      "pitcher",
      positionOverrides
    );
    rotoMap = new Map([...hitterMap, ...pitcherMap]);
  }
  return players.map((p) => {
    const derived =
      fmt === "points"
        ? pointsBaseline(p, rosterSlots, scoringCategories, positionOverrides)
        : rotoMap.get(String(p._id)) ??
          rotisserieBaseline(p, rosterSlots, positionOverrides);
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
