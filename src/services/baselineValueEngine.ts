import type {
  LeanPlayer,
  RosterSlot,
  ScoringCategory,
  ScoringFormat,
} from "../types/brain";

type ProjectionNode = Record<string, number | string | undefined>;

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
  const batting = getProjectionSection(p, "batting");
  const pitching = getProjectionSection(p, "pitching");
  const section = isPitcher(p) ? pitching : batting;
  const categories = scoringCategories.length > 0 ? scoringCategories : [];

  let projectionScore = 0;
  for (const cat of categories) {
    const key = cat.name.toUpperCase();
    let statVal = 0;
    if (key === "HR") statVal = toNum(section.hr);
    else if (key === "RBI") statVal = toNum(section.rbi);
    else if (key === "R") statVal = toNum(section.runs);
    else if (key === "SB") statVal = toNum(section.sb);
    else if (key === "AVG") statVal = toNum(section.avg) * 1000;
    else if (key === "OBP") statVal = toNum(section.obp) * 1000;
    else if (key === "K") statVal = toNum(section.strikeouts);
    else if (key === "W") statVal = toNum(section.wins);
    else if (key === "SV") statVal = toNum(section.saves);
    else if (key === "ERA") statVal = Math.max(0, 5 - toNum(section.era));
    else if (key === "WHIP") statVal = Math.max(0, 2 - toNum(section.whip));
    else if (key === "QS") statVal = toNum(section.qualityStarts);
    projectionScore += statVal * categoryWeight(key);
  }

  const projectionComponent = Math.max(0, projectionScore * 0.02);
  const scarcityComponent = scarcityMultiplierForPosition(p, rosterSlots) - 1;
  const value = Math.max(
    1,
    (p.value || 0) * (1 + scarcityComponent) + projectionComponent
  );
  return { value, projectionComponent, scarcityComponent };
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
  const value = Math.max(
    1,
    (p.value || 0) * (1 + scarcityComponent) + projectionComponent
  );
  return { value, projectionComponent, scarcityComponent };
}

export function scoringAwareBaselinePlayers(
  players: LeanPlayer[],
  scoringFormat: ScoringFormat | undefined,
  scoringCategories: ScoringCategory[],
  rosterSlots: RosterSlot[]
): LeanPlayer[] {
  const fmt = scoringFormat ?? "5x5";
  return players.map((p) => {
    const derived =
      fmt === "points"
        ? pointsBaseline(p, rosterSlots)
        : rotisserieBaseline(p, scoringCategories, rosterSlots);
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
