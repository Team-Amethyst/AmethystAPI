/**
 * Sync script — fetches live player data from the MLB Stats API and upserts
 * into the `players` collection so the Amethyst Engine and Draftroom share
 * the same canonical player IDs (MLB numeric IDs).
 *
 * Persists merged hitting + pitching splits per player (so two-way players
 * keep both `stats` / `projection` blobs), `positions[]` from split + bio
 * (including `TWP` → DH/SP). **`stats`** = last completed MLB season only.
 * **`projection`** = weighted 5:3:2 blend over the last three completed seasons
 * (see `src/lib/mlbProjectionBlend.ts`). `catalogMeta` records which seasons were used.
 *
 * Run with:  pnpm sync-players
 *
 * Safe to re-run — uses upsert on mlbId so no duplicates are created.
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import {
  assignTier,
  calcAge,
  calcBatterValue,
  calcPitcherValue,
} from "../src/lib/mlbSyncFormulas";
import { projectBatting, projectPitching } from "../src/lib/mlbProjectionBlend";
import { resolveMlbTeamAbbrev } from "../src/lib/mlbTeamResolve";
import Player from "../src/models/Player";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI not set in .env");
  process.exit(1);
}

const MLB_API = "https://statsapi.mlb.com/api/v1";
/** Last completed calendar season (aligns with monolith / Draft Kit “last year” stat basis). */
const LAST_COMPLETED_SEASON = new Date().getFullYear() - 1;

interface MlbPlayer {
  id: number;
  fullName: string;
  currentTeam?: { id?: number; abbreviation?: string };
  primaryPosition?: { abbreviation: string };
  birthDate?: string;
}

type SplitAgg = {
  bat?: MlbStatSplit;
  pit?: MlbStatSplit;
};

type PlayerSyncDoc = {
  mlbId: number;
  name: string;
  team: string;
  position: string;
  positions?: string[];
  age: number;
  depthChartPosition?: number;
  value: number;
  tier: number;
  stats: Record<string, unknown>;
  projection: Record<string, unknown>;
  outlook: string;
  adp?: number;
  catalogMeta?: {
    stats_season: number;
    projection_blend_seasons: number[];
  };
};

function addMlbPositionAbbrev(set: Set<string>, abbrev?: string): void {
  if (!abbrev) return;
  const u = abbrev.trim().toUpperCase();
  if (u === "TWP") {
    set.add("DH");
    set.add("SP");
  } else if (u.length > 0) {
    set.add(u);
  }
}

function buildPlayerDocFromAgg(
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

  const value = Math.max(batVal, pitVal);
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
    projection.batting = {
      avg: String(stat.avg ?? ".000"),
      hr: Number(stat.homeRuns ?? 0),
      rbi: Number(stat.rbi ?? 0),
      runs: Number(stat.runs ?? 0),
      sb: Number(stat.stolenBases ?? 0),
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
    };
  }

  const doc: PlayerSyncDoc = {
    mlbId,
    name: agg.bat?.player.fullName ?? agg.pit?.player.fullName ?? bio?.fullName ?? "Unknown",
    team,
    position,
    age: calcAge(bio?.birthDate),
    depthChartPosition: deriveDepthChartPosition(agg),
    value,
    tier: assignTier(value),
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

function deriveDepthChartPosition(agg: SplitAgg): number | undefined {
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

interface MlbStatSplit {
  player: { id: number; fullName: string };
  team?: { id?: number; abbreviation?: string };
  position?: { abbreviation: string };
  stat: Record<string, string | number>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

async function fetchSeasonSplitsForYear(season: number): Promise<{
  batSplits: MlbStatSplit[];
  pitSplits: MlbStatSplit[];
}> {
  const [batJson, pitJson] = await Promise.all([
    fetchJson<{ stats: { splits: MlbStatSplit[] }[] }>(
      `${MLB_API}/stats?stats=season&group=hitting&season=${season}&playerPool=ALL&limit=400&sportId=1`
    ),
    fetchJson<{ stats: { splits: MlbStatSplit[] }[] }>(
      `${MLB_API}/stats?stats=season&group=pitching&season=${season}&playerPool=ALL&limit=300&sportId=1`
    ),
  ]);
  const batSplits = batJson.stats?.[0]?.splits ?? [];
  const pitSplits = pitJson.stats?.[0]?.splits ?? [];
  return { batSplits, pitSplits };
}

function indexBattingByPlayer(
  splits: MlbStatSplit[]
): Map<number, Record<string, string | number>> {
  const m = new Map<number, Record<string, string | number>>();
  for (const s of splits) {
    m.set(s.player.id, s.stat as Record<string, string | number>);
  }
  return m;
}

function indexPitchingByPlayer(
  splits: MlbStatSplit[]
): Map<number, Record<string, string | number>> {
  const m = new Map<number, Record<string, string | number>>();
  for (const s of splits) {
    m.set(s.player.id, s.stat as Record<string, string | number>);
  }
  return m;
}

async function fetchTeamAbbrevMap(): Promise<Map<number, string>> {
  const teamsJson = await fetchJson<{ teams: { id: number; abbreviation: string }[] }>(
    `${MLB_API}/teams?sportId=1&season=${LAST_COMPLETED_SEASON}`
  );
  const teamIdToAbbr = new Map<number, string>();
  for (const t of teamsJson.teams ?? []) {
    teamIdToAbbr.set(t.id, t.abbreviation);
  }
  return teamIdToAbbr;
}

async function fetchBioMap(playerIds: number[]): Promise<Map<number, MlbPlayer>> {
  const bioMap = new Map<number, MlbPlayer>();
  if (playerIds.length === 0) return bioMap;
  try {
    const bioJson = await fetchJson<{ people: MlbPlayer[] }>(
      `${MLB_API}/people?personIds=${playerIds.join(",")}&hydrate=currentTeam`
    );
    for (const p of bioJson.people ?? []) bioMap.set(p.id, p);
  } catch (err) {
    console.warn("[MLB API] Bio fetch failed (non-fatal):", (err as Error).message);
  }
  return bioMap;
}

function aggregatePositiveSplits(
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

function assignAdpByValue(players: PlayerSyncDoc[]): PlayerSyncDoc[] {
  const sorted = [...players].sort((a, b) => b.value - a.value);
  sorted.forEach((p, i) => {
    p.adp = i + 1;
  });
  return sorted;
}

async function sync() {
  await mongoose.connect(MONGO_URI as string);
  const last = LAST_COMPLETED_SEASON;
  const seasons = [last, last - 1, last - 2] as const;
  console.log(`[MongoDB] Connected — syncing stats ${last}, projection blend ${seasons.join("/")}`);

  const perYear = await Promise.all(seasons.map((se) => fetchSeasonSplitsForYear(se)));
  const yearBat = new Map<number, Map<number, Record<string, string | number>>>();
  const yearPit = new Map<number, Map<number, Record<string, string | number>>>();
  for (let i = 0; i < seasons.length; i++) {
    const se = seasons[i]!;
    yearBat.set(se, indexBattingByPlayer(perYear[i]!.batSplits));
    yearPit.set(se, indexPitchingByPlayer(perYear[i]!.pitSplits));
  }
  const batSplits = perYear[0]!.batSplits;
  const pitSplits = perYear[0]!.pitSplits;
  console.log(
    `[MLB API] ${batSplits.length} batting / ${pitSplits.length} pitching splits (anchor year ${last})`
  );

  const teamIdToAbbr = await fetchTeamAbbrevMap();
  console.log(`[MLB API] Loaded ${teamIdToAbbr.size} team abbreviations`);

  // Fetch bio data for all players (bounded to avoid oversized query string).
  const playerIds = [
    ...new Set([...batSplits.map((s) => s.player.id), ...pitSplits.map((s) => s.player.id)]),
  ].slice(0, 600);

  const bioMap = await fetchBioMap(playerIds);
  console.log(`[MLB API] Fetched bio for ${bioMap.size} players`);

  /** Merge hitting + pitching splits per player so two-way rows keep both stat blobs and eligibilities. */
  const aggMap = aggregatePositiveSplits(batSplits, pitSplits);
  const playerMap = new Map<number, PlayerSyncDoc>();
  for (const [mlbId, agg] of aggMap) {
    const bio = bioMap.get(mlbId);
    const doc = buildPlayerDocFromAgg(mlbId, agg, bio, teamIdToAbbr, yearBat, yearPit, last);
    if (doc) playerMap.set(mlbId, doc);
  }

  // Assign ADP by value rank
  const players = assignAdpByValue([...playerMap.values()]);

  // Upsert all players — safe to re-run
  const ops = players.map((p) => ({
    updateOne: {
      filter: { mlbId: p.mlbId },
      update: { $set: p },
      upsert: true,
    },
  }));

  const result = await Player.bulkWrite(ops);
  console.log(
    `[Sync] Done — ${result.upsertedCount} inserted, ${result.modifiedCount} updated, ${players.length} total`
  );

  await mongoose.disconnect();
  console.log("[MongoDB] Disconnected");
}

sync().catch((err) => {
  console.error("[Sync] Error:", err);
  process.exit(1);
});
