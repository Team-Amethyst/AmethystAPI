/**
 * Shared MLB → catalog player document construction from season splits.
 * Used by `scripts/sync-players.ts` and `src/lib/mlbCatalogUniverse`.
 * Do not change valuation formulas here — only move/copy mechanical wiring.
 */
import {
  assignTier,
  calcAge,
  calcBatterValue,
  calcPitcherValue,
  catalogDollarValueFromProjection,
} from "./mlbSyncFormulas";
import {
  applyAnchorYearProjectionEnrichment,
  estimateQualityStartsFromSeasonAggregate,
  projectBatting,
  projectPitching,
} from "./mlbProjectionBlend";
import { resolveMlbTeamAbbrev } from "./mlbTeamResolve";

export interface MlbPlayer {
  id: number;
  fullName: string;
  currentTeam?: { id?: number; abbreviation?: string };
  primaryPosition?: { abbreviation: string };
  birthDate?: string;
}

export type SplitAgg = {
  bat?: MlbStatSplit;
  pit?: MlbStatSplit;
};

export type PlayerSyncDoc = {
  mlbId: number;
  catalogKind: "mlb";
  name: string;
  team: string;
  position: string;
  positions?: string[];
  age: number;
  depthChartPosition?: number;
  value: number;
  catalog_tier: number;
  stats: Record<string, unknown>;
  projection: Record<string, unknown>;
  outlook: string;
  catalog_rank?: number;
  catalogMeta?: {
    stats_season: number;
    projection_blend_seasons: number[];
  };
  /** When set, gates valuation pool vs research-only catalog rows (roster universe v1). */
  catalogValuationTier?: "valuation_eligible" | "market_only" | "roster_context";
  market_adp?: number;
  market_adp_source?: string;
  market_adp_updated_at?: string;
  market_adp_min?: number;
  market_adp_max?: number;
  market_pick_count?: number;
};

export interface MlbStatSplit {
  player: { id: number; fullName: string };
  team?: { id?: number; abbreviation?: string };
  position?: { abbreviation: string };
  stat: Record<string, string | number>;
}

export function addMlbPositionAbbrev(set: Set<string>, abbrev?: string): void {
  if (!abbrev) return;
  const u = abbrev.trim().toUpperCase();
  if (u === "TWP") {
    set.add("DH");
    set.add("SP");
  } else if (u.length > 0) {
    set.add(u);
  }
}

export function deriveDepthChartPosition(agg: SplitAgg): number | undefined {
  const asNum = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };
  const batStat = agg.bat?.stat ?? {};
  const pitStat = agg.pit?.stat ?? {};
  const pa = asNum((batStat as Record<string, unknown>).plateAppearances);
  const ab = asNum((batStat as Record<string, unknown>).atBats);
  const hitterVolume = pa ?? ab ?? 0;

  const gs = asNum((pitStat as Record<string, unknown>).gamesStarted);
  const sv = asNum((pitStat as Record<string, unknown>).saves);
  const ip = asNum((pitStat as Record<string, unknown>).inningsPitched);

  const hitterDepth =
    hitterVolume >= 420 ? 1 : hitterVolume >= 180 ? 2 : hitterVolume > 0 ? 3 : undefined;
  const pitcherDepth =
    (gs ?? 0) >= 20 || (ip ?? 0) >= 120
      ? 1
      : (gs ?? 0) >= 8 || (sv ?? 0) >= 15 || (ip ?? 0) >= 45
        ? 2
        : (gs ?? 0) > 0 || (sv ?? 0) > 0 || (ip ?? 0) > 0
          ? 3
          : undefined;

  if (hitterDepth == null) return pitcherDepth;
  if (pitcherDepth == null) return hitterDepth;
  return Math.min(hitterDepth, pitcherDepth);
}

export function aggregatePositiveSplits(
  batSplits: MlbStatSplit[],
  pitSplits: MlbStatSplit[]
): Map<number, SplitAgg> {
  const aggMap = new Map<number, SplitAgg>();
  for (const s of batSplits) {
    if (calcBatterValue(s.stat) <= 0) continue;
    const row = aggMap.get(s.player.id) ?? {};
    row.bat = s;
    aggMap.set(s.player.id, row);
  }
  for (const s of pitSplits) {
    if (calcPitcherValue(s.stat) <= 0) continue;
    const row = aggMap.get(s.player.id) ?? {};
    row.pit = s;
    aggMap.set(s.player.id, row);
  }
  return aggMap;
}

export function indexBattingByPlayer(
  splits: MlbStatSplit[]
): Map<number, Record<string, string | number>> {
  const m = new Map<number, Record<string, string | number>>();
  for (const s of splits) {
    m.set(s.player.id, s.stat as Record<string, string | number>);
  }
  return m;
}

export function indexPitchingByPlayer(
  splits: MlbStatSplit[]
): Map<number, Record<string, string | number>> {
  const m = new Map<number, Record<string, string | number>>();
  for (const s of splits) {
    m.set(s.player.id, s.stat as Record<string, string | number>);
  }
  return m;
}

/** Latest split per player (walk order wins — matches sync-players indexing). */
export function indexLatestBatSplitByPlayer(splits: MlbStatSplit[]): Map<number, MlbStatSplit> {
  const m = new Map<number, MlbStatSplit>();
  for (const s of splits) {
    m.set(s.player.id, s);
  }
  return m;
}

export function indexLatestPitSplitByPlayer(splits: MlbStatSplit[]): Map<number, MlbStatSplit> {
  const m = new Map<number, MlbStatSplit>();
  for (const s of splits) {
    m.set(s.player.id, s);
  }
  return m;
}

export function buildPlayerDocFromAgg(
  mlbId: number,
  agg: SplitAgg,
  bio: MlbPlayer | undefined,
  teamIdToAbbr: Map<number, string>,
  yearBat: Map<number, Map<number, Record<string, string | number>>>,
  yearPit: Map<number, Map<number, Record<string, string | number>>>,
  lastSeason: number
): PlayerSyncDoc | null {
  const batVal = agg.bat ? calcBatterValue(agg.bat.stat) : 0;
  const pitVal = agg.pit ? calcPitcherValue(agg.pit.stat) : 0;
  if (batVal <= 0 && pitVal <= 0) return null;

  let value = Math.max(batVal, pitVal);
  const team = resolveMlbTeamAbbrev(
    agg.bat?.team ?? agg.pit?.team,
    bio?.currentTeam,
    teamIdToAbbr
  );

  const posSet = new Set<string>();
  addMlbPositionAbbrev(posSet, agg.bat?.position?.abbreviation);
  addMlbPositionAbbrev(posSet, agg.pit?.position?.abbreviation);
  addMlbPositionAbbrev(posSet, bio?.primaryPosition?.abbreviation);

  const primaryBio = bio?.primaryPosition?.abbreviation?.trim().toUpperCase();
  let position: string;
  if (primaryBio === "TWP") {
    position = batVal >= pitVal ? "DH" : "SP";
  } else if (agg.bat && !agg.pit) {
    position =
      agg.bat.position?.abbreviation ??
      bio?.primaryPosition?.abbreviation ??
      "OF";
  } else if (agg.pit && !agg.bat) {
    position =
      agg.pit.position?.abbreviation ??
      bio?.primaryPosition?.abbreviation ??
      "SP";
  } else if (agg.bat && agg.pit) {
    position =
      batVal >= pitVal
        ? agg.bat.position?.abbreviation ?? "DH"
        : agg.pit.position?.abbreviation ?? "SP";
  } else {
    position = bio?.primaryPosition?.abbreviation ?? "OF";
  }

  const positions = [...posSet].filter((p) => p !== position);

  const stats: Record<string, unknown> = {};
  if (agg.bat) {
    const stat = agg.bat.stat;
    stats.batting = {
      avg: String(stat.avg ?? ".000"),
      hr: Number(stat.homeRuns ?? 0),
      rbi: Number(stat.rbi ?? 0),
      runs: Number(stat.runs ?? 0),
      sb: Number(stat.stolenBases ?? 0),
      obp: String(stat.obp ?? ".000"),
      slg: String(stat.slg ?? ".000"),
    };
  }
  if (agg.pit) {
    const stat = agg.pit.stat;
    stats.pitching = {
      era: String(stat.era ?? "0.00"),
      whip: String(stat.whip ?? "0.00"),
      wins: Number(stat.wins ?? 0),
      saves: Number(stat.saves ?? 0),
      strikeouts: Number(stat.strikeOuts ?? 0),
      innings: String(stat.inningsPitched ?? "0"),
    };
  }

  const y2 = lastSeason - 1;
  const y3 = lastSeason - 2;
  const bat1 = yearBat.get(lastSeason)?.get(mlbId);
  const bat2 = yearBat.get(y2)?.get(mlbId);
  const bat3 = yearBat.get(y3)?.get(mlbId);
  const pit1 = yearPit.get(lastSeason)?.get(mlbId);
  const pit2 = yearPit.get(y2)?.get(mlbId);
  const pit3 = yearPit.get(y3)?.get(mlbId);

  const blendedBat = projectBatting(bat1, bat2, bat3);
  const blendedPit = projectPitching(pit1, pit2, pit3);

  const projection: Record<string, unknown> = {};
  if (blendedBat) {
    projection.batting = blendedBat;
  } else if (agg.bat) {
    const stat = agg.bat.stat;
    const ab = Number(stat.atBats ?? 0);
    const bb = Number(stat.baseOnBalls ?? 0);
    const pa =
      Number(stat.plateAppearances ?? 0) > 0
        ? Number(stat.plateAppearances)
        : ab + bb;
    const obpStr = String(stat.obp ?? ".000");
    const obpNum = parseFloat(obpStr);
    const tb = Number(stat.totalBases ?? 0);
    const slgNum =
      parseFloat(String(stat.slg ?? "").trim()) ||
      (ab > 0 ? tb / ab : 0);
    const opsNum =
      parseFloat(String(stat.ops ?? "").trim()) ||
      (Number.isFinite(obpNum) ? obpNum + slgNum : 0);
    projection.batting = {
      avg: String(stat.avg ?? ".000"),
      hr: Number(stat.homeRuns ?? 0),
      rbi: Number(stat.rbi ?? 0),
      runs: Number(stat.runs ?? 0),
      sb: Number(stat.stolenBases ?? 0),
      atBats: ab,
      obp: Number.isFinite(obpNum) ? obpStr : ".000",
      plateAppearances: Math.max(0, Math.round(pa)),
      totalBases: tb,
      slg: Number.isFinite(slgNum) ? slgNum.toFixed(3) : ".000",
      ops: Number.isFinite(opsNum) ? opsNum.toFixed(3) : ".000",
    };
  }
  if (blendedPit) {
    projection.pitching = {
      era: blendedPit.era,
      whip: blendedPit.whip,
      wins: blendedPit.wins,
      saves: blendedPit.saves,
      strikeouts: blendedPit.strikeouts,
      innings: blendedPit.innings,
      holds: blendedPit.holds,
      qualityStarts: blendedPit.qualityStarts,
    };
  } else if (agg.pit) {
    const stat = agg.pit.stat;
    projection.pitching = {
      era: String(stat.era ?? "0.00"),
      whip: String(stat.whip ?? "0.00"),
      wins: Number(stat.wins ?? 0),
      saves: Number(stat.saves ?? 0),
      strikeouts: Number(stat.strikeOuts ?? 0),
      innings: String(stat.inningsPitched ?? "0"),
      holds: Number(stat.holds ?? 0),
      qualityStarts: estimateQualityStartsFromSeasonAggregate(stat),
    };
  }

  if (Object.keys(projection).length > 0) {
    applyAnchorYearProjectionEnrichment(
      projection,
      agg.bat?.stat,
      agg.pit?.stat
    );
  }

  const projectionDollar = catalogDollarValueFromProjection(projection);
  if (projectionDollar > value) value = projectionDollar;

  const doc: PlayerSyncDoc = {
    mlbId,
    catalogKind: "mlb",
    name: agg.bat?.player.fullName ?? agg.pit?.player.fullName ?? bio?.fullName ?? "Unknown",
    team,
    position,
    age: calcAge(bio?.birthDate),
    depthChartPosition: deriveDepthChartPosition(agg),
    value,
    catalog_tier: assignTier(value),
    stats,
    projection,
    outlook: "",
    catalogMeta: {
      stats_season: lastSeason,
      projection_blend_seasons: [lastSeason, y2, y3],
    },
  };
  if (positions.length > 0) {
    doc.positions = positions;
  }
  return doc;
}

export function assignCatalogRankByValue(players: PlayerSyncDoc[]): PlayerSyncDoc[] {
  const sorted = [...players].sort((a, b) => b.value - a.value);
  sorted.forEach((p, i) => {
    p.catalog_rank = i + 1;
  });
  return sorted;
}
