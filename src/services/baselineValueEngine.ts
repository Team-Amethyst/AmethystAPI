import type {
  LeanPlayer,
  RosterSlot,
  ScoringCategory,
  ScoringFormat,
} from "../types/brain";
import {
  categoryDirection,
  categoryRawValue,
  categoryWeight,
  getProjectionSection,
  isPitcherForBaseline,
  mean,
  stdDev,
  toNum,
} from "./baselineProjectionStats";
import { applyBaselineRiskChain } from "./baselineRiskChain";

type BaselineComponents = {
  value: number;
  projectionComponent: number;
  scarcityComponent: number;
  ageDepthComponent?: number;
  injuryComponent?: number;
};

type RotoGroupKind = "hitter" | "pitcher";

/**
 * When catalog dollars are tiny but ADP/tier still show real draft interest,
 * lift baseline slightly so late picks and spec arms are not all $1 anchors.
 */
function speculativePriorBaselineFloor(p: LeanPlayer): number | null {
  const catalog = p.value ?? 0;
  if (catalog >= 4) return null;
  const adp = typeof p.adp === "number" && Number.isFinite(p.adp) && p.adp > 0 ? p.adp : null;
  const tier = typeof p.tier === "number" && Number.isFinite(p.tier) ? p.tier : null;
  if (adp == null || adp > 200) return null;
  if (tier == null || tier > 4) return null;
  const fromAdp = 2.4 + (200 - adp) * 0.034;
  const fromTier = (5 - tier) * 0.85;
  return Math.min(15, fromAdp + fromTier);
}

function rotoBaselineForGroup(
  group: LeanPlayer[],
  categories: ScoringCategory[],
  rosterSlots: RosterSlot[],
  groupKind: RotoGroupKind
): Map<string, BaselineComponents> {
  const out = new Map<string, BaselineComponents>();
  if (group.length === 0) return out;
  if (categories.length === 0) {
    for (const p of group) {
      const scarcityComponent = scarcityMultiplierForPosition(p, rosterSlots) - 1;
      const scarcityAdjusted = Math.max(1, (p.value || 0) * (1 + scarcityComponent));
      const priorFloor = speculativePriorBaselineFloor(p);
      const baseValue = Math.max(
        1,
        priorFloor != null ? Math.max(scarcityAdjusted, priorFloor) : scarcityAdjusted
      );
      const risk = applyBaselineRiskChain({
        player: p,
        baselineValue: baseValue,
        isPitcher: isPitcherForBaseline(p),
      });
      out.set(String(p._id), {
        value: Number(risk.adjustedValue.toFixed(2)),
        projectionComponent: 0,
        scarcityComponent,
        ageDepthComponent: risk.ageDepthComponent,
        injuryComponent: risk.injuryComponent,
      });
    }
    return out;
  }

  const catStats = categories.map((cat) => {
    const vals = group.map((p) =>
      categoryRawValue(
        getProjectionSection(p, isPitcherForBaseline(p) ? "pitching" : "batting"),
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
    const section = getProjectionSection(p, isPitcherForBaseline(p) ? "pitching" : "batting");
    let zWeighted = 0;
    for (const c of catStats) {
      const raw = categoryRawValue(section, c.cat.name);
      if (c.stdev <= 1e-9) continue;
      let z = (raw - c.avg) / c.stdev;
      if (categoryDirection(c.cat.name) === "lower") z = -z;
      zWeighted += z * categoryWeight(c.cat.name);
    }

    const zScale = groupKind === "pitcher" ? 0.092 : 0.08;
    const zLo = groupKind === "pitcher" ? 0.48 : 0.55;
    const zHi = groupKind === "pitcher" ? 1.92 : 1.7;
    const projectionMult = Math.max(zLo, Math.min(zHi, 1 + zWeighted * zScale));
    const scarcityComponent = scarcityMultiplierForPosition(p, rosterSlots) - 1;
    const scarcityAdjusted = Math.max(1, (p.value || 0) * (1 + scarcityComponent));
    let value = Math.max(1, scarcityAdjusted * projectionMult);
    const priorFloor = speculativePriorBaselineFloor(p);
    if (priorFloor != null) value = Math.max(value, priorFloor);
    const risk = applyBaselineRiskChain({
      player: p,
      baselineValue: value,
      isPitcher: isPitcherForBaseline(p),
    });
    out.set(String(p._id), {
      value: Number(risk.adjustedValue.toFixed(2)),
      projectionComponent: Number((value - scarcityAdjusted).toFixed(2)),
      scarcityComponent,
      ageDepthComponent: risk.ageDepthComponent,
      injuryComponent: risk.injuryComponent,
    });
  }
  return out;
}

function scarcityMultiplierForPosition(p: LeanPlayer, rosterSlots: RosterSlot[]): number {
  if (rosterSlots.length === 0) return 1;
  const pos = p.position.toUpperCase();
  let demand = 1;
  for (const slot of rosterSlots) {
    const key = slot.position.toUpperCase();
    if (pos.includes(key) || key.includes(pos)) {
      demand = Math.max(demand, slot.count);
    }
    if (key === "UTIL" && !isPitcherForBaseline(p)) {
      demand = Math.max(demand, 1);
    }
  }
  const bounded = Math.min(1.25, 1 + (demand - 1) * 0.05);
  return Number(bounded.toFixed(4));
}

function rotisserieBaseline(
  p: LeanPlayer,
  rosterSlots: RosterSlot[]
): {
  value: number;
  projectionComponent: number;
  scarcityComponent: number;
  ageDepthComponent?: number;
  injuryComponent?: number;
} {
  const scarcityComponent = scarcityMultiplierForPosition(p, rosterSlots) - 1;
  const scarcityAdjusted = Math.max(1, (p.value || 0) * (1 + scarcityComponent));
  const risk = applyBaselineRiskChain({
    player: p,
    baselineValue: scarcityAdjusted,
    isPitcher: isPitcherForBaseline(p),
  });
  return {
    value: Number(risk.adjustedValue.toFixed(2)),
    projectionComponent: 0,
    scarcityComponent,
    ageDepthComponent: risk.ageDepthComponent,
    injuryComponent: risk.injuryComponent,
  };
}

function pointsBaseline(
  p: LeanPlayer,
  rosterSlots: RosterSlot[]
): {
  value: number;
  projectionComponent: number;
  scarcityComponent: number;
  ageDepthComponent?: number;
  injuryComponent?: number;
} {
  const batting = getProjectionSection(p, "batting");
  const pitching = getProjectionSection(p, "pitching");
  const scarcityComponent = scarcityMultiplierForPosition(p, rosterSlots) - 1;

  let points = 0;
  if (isPitcherForBaseline(p)) {
    points =
      toNum(pitching.strikeouts) * 1 +
      toNum(pitching.wins) * 6 +
      toNum(pitching.saves) * 5 -
      toNum(pitching.era) * 4 -
      toNum(pitching.whip) * 6;
  } else {
    points =
      toNum(batting.hr) * 4 +
      toNum(batting.rbi) * 1 +
      toNum(batting.runs) * 1 +
      toNum(batting.sb) * 2 +
      toNum(batting.avg) * 120;
  }
  const projectionComponent = Math.max(0, points * 0.03);
  let value = Math.max(
    1,
    (p.value || 0) * (1 + scarcityComponent) + projectionComponent
  );
  const priorFloor = speculativePriorBaselineFloor(p);
  if (priorFloor != null) value = Math.max(value, priorFloor);
  const risk = applyBaselineRiskChain({
    player: p,
    baselineValue: value,
    isPitcher: isPitcherForBaseline(p),
  });
  return {
    value: risk.adjustedValue,
    projectionComponent,
    scarcityComponent,
    ageDepthComponent: risk.ageDepthComponent,
    injuryComponent: risk.injuryComponent,
  };
}

export function scoringAwareBaselinePlayers(
  players: LeanPlayer[],
  scoringFormat: ScoringFormat | undefined,
  scoringCategories: ScoringCategory[],
  rosterSlots: RosterSlot[]
): LeanPlayer[] {
  const fmt = scoringFormat ?? "5x5";
  let rotoMap = new Map<string, BaselineComponents>();
  if (fmt !== "points") {
    const hitterCats = scoringCategories.filter((c) => c.type === "batting");
    const pitcherCats = scoringCategories.filter((c) => c.type === "pitching");
    const hitters = players.filter((p) => !isPitcherForBaseline(p));
    const pitchers = players.filter((p) => isPitcherForBaseline(p));
    const hitterMap = rotoBaselineForGroup(hitters, hitterCats, rosterSlots, "hitter");
    const pitcherMap = rotoBaselineForGroup(
      pitchers,
      pitcherCats,
      rosterSlots,
      "pitcher"
    );
    rotoMap = new Map([...hitterMap, ...pitcherMap]);
  }
  return players.map((p) => {
    const derived =
      fmt === "points"
        ? pointsBaseline(p, rosterSlots)
        : rotoMap.get(String(p._id)) ??
          rotisserieBaseline(p, rosterSlots);
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
