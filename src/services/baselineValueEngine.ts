import type {
  LeanPlayer,
  RosterSlot,
  ScoringCategory,
  ScoringFormat,
} from "../types/brain";

type ProjectionNode = Record<string, number | string | undefined>;
type CategoryDirection = "higher" | "lower";

function toNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getProjectionSection(
  p: LeanPlayer,
  section: "batting" | "pitching"
): ProjectionNode {
  const projection = p.projection as
    | Record<string, ProjectionNode | undefined>
    | undefined;
  return projection?.[section] ?? {};
}

function isPitcher(p: LeanPlayer): boolean {
  const pos = p.position.toUpperCase();
  return pos.includes("SP") || pos.includes("RP") || pos.includes("P");
}

function categoryWeight(name: string): number {
  const key = name.toUpperCase();
  if (key === "AVG" || key === "OBP" || key === "ERA" || key === "WHIP") return 14;
  if (key === "HR" || key === "RBI" || key === "R" || key === "K") return 1;
  if (key === "SB" || key === "SV" || key === "W") return 1.6;
  if (key === "QS") return 1.2;
  return 0.8;
}

function statFieldForCategory(name: string): string | null {
  const key = name.toUpperCase();
  if (key === "HR") return "hr";
  if (key === "RBI") return "rbi";
  if (key === "R") return "runs";
  if (key === "SB") return "sb";
  if (key === "AVG") return "avg";
  if (key === "OBP") return "obp";
  if (key === "K") return "strikeouts";
  if (key === "W") return "wins";
  if (key === "SV") return "saves";
  if (key === "ERA") return "era";
  if (key === "WHIP") return "whip";
  if (key === "QS") return "qualityStarts";
  return null;
}

function categoryDirection(name: string): CategoryDirection {
  const key = name.toUpperCase();
  return key === "ERA" || key === "WHIP" ? "lower" : "higher";
}

function categoryRawValue(section: ProjectionNode, name: string): number {
  const field = statFieldForCategory(name);
  if (!field) return 0;
  const raw = toNum(section[field as keyof ProjectionNode]);
  const key = name.toUpperCase();
  if (key === "AVG" || key === "OBP") return raw * 1000;
  return raw;
}

function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function stdDev(vals: number[]): number {
  if (vals.length <= 1) return 0;
  const m = mean(vals);
  const variance =
    vals.reduce((s, v) => s + (v - m) * (v - m), 0) / (vals.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

type BaselineComponents = {
  value: number;
  projectionComponent: number;
  scarcityComponent: number;
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
      const value = Math.max(
        1,
        priorFloor != null ? Math.max(scarcityAdjusted, priorFloor) : scarcityAdjusted
      );
      out.set(String(p._id), {
        value: Number(value.toFixed(2)),
        projectionComponent: 0,
        scarcityComponent,
      });
    }
    return out;
  }

  const catStats = categories.map((cat) => {
    const vals = group.map((p) =>
      categoryRawValue(
        getProjectionSection(p, isPitcher(p) ? "pitching" : "batting"),
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
    const section = getProjectionSection(p, isPitcher(p) ? "pitching" : "batting");
    let zWeighted = 0;
    for (const c of catStats) {
      const raw = categoryRawValue(section, c.cat.name);
      if (c.stdev <= 1e-9) continue;
      let z = (raw - c.avg) / c.stdev;
      if (categoryDirection(c.cat.name) === "lower") z = -z;
      zWeighted += z * categoryWeight(c.cat.name);
    }

    // Pitchers: ERA/WHIP/K variance is sharper in-category; allow a slightly wider $ swing.
    const zScale = groupKind === "pitcher" ? 0.092 : 0.08;
    const zLo = groupKind === "pitcher" ? 0.48 : 0.55;
    const zHi = groupKind === "pitcher" ? 1.92 : 1.7;
    const projectionMult = Math.max(zLo, Math.min(zHi, 1 + zWeighted * zScale));
    const scarcityComponent = scarcityMultiplierForPosition(p, rosterSlots) - 1;
    const scarcityAdjusted = Math.max(1, (p.value || 0) * (1 + scarcityComponent));
    let value = Math.max(1, scarcityAdjusted * projectionMult);
    const priorFloor = speculativePriorBaselineFloor(p);
    if (priorFloor != null) value = Math.max(value, priorFloor);
    out.set(String(p._id), {
      value: Number(value.toFixed(2)),
      projectionComponent: Number((value - scarcityAdjusted).toFixed(2)),
      scarcityComponent,
    });
  }
  return out;
}

function scarcityMultiplierForPosition(
  p: LeanPlayer,
  rosterSlots: RosterSlot[]
): number {
  if (rosterSlots.length === 0) return 1;
  const pos = p.position.toUpperCase();
  let demand = 1;
  for (const slot of rosterSlots) {
    const key = slot.position.toUpperCase();
    if (pos.includes(key) || key.includes(pos)) {
      demand = Math.max(demand, slot.count);
    }
    if (key === "UTIL" && !isPitcher(p)) {
      demand = Math.max(demand, 1);
    }
  }
  const bounded = Math.min(1.25, 1 + (demand - 1) * 0.05);
  return Number(bounded.toFixed(4));
}

function rotisserieBaseline(
  p: LeanPlayer,
  scoringCategories: ScoringCategory[],
  rosterSlots: RosterSlot[]
): { value: number; projectionComponent: number; scarcityComponent: number } {
  const scarcityComponent = scarcityMultiplierForPosition(p, rosterSlots) - 1;
  const scarcityAdjusted = Math.max(1, (p.value || 0) * (1 + scarcityComponent));
  return {
    value: Number(scarcityAdjusted.toFixed(2)),
    projectionComponent: 0,
    scarcityComponent,
  };
}

function pointsBaseline(
  p: LeanPlayer,
  rosterSlots: RosterSlot[]
): { value: number; projectionComponent: number; scarcityComponent: number } {
  const batting = getProjectionSection(p, "batting");
  const pitching = getProjectionSection(p, "pitching");
  const scarcityComponent = scarcityMultiplierForPosition(p, rosterSlots) - 1;

  let points = 0;
  if (isPitcher(p)) {
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
  return { value, projectionComponent, scarcityComponent };
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
    const hitters = players.filter((p) => !isPitcher(p));
    const pitchers = players.filter((p) => isPitcher(p));
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
          rotisserieBaseline(p, scoringCategories, rosterSlots);
    const baselineComponents = {
      scoring_format: fmt,
      projection_component: Number(derived.projectionComponent.toFixed(2)),
      scarcity_component: Number(derived.scarcityComponent.toFixed(4)),
    };
    return {
      ...p,
      value: Number(derived.value.toFixed(2)),
      // preserve for explainability in response
      projection: {
        ...(p.projection ?? {}),
        __valuation_meta__: baselineComponents,
      },
    };
  });
}
