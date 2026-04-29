/**
 * Sync script — fetches live player data from the MLB Stats API and upserts
 * into the `players` collection so the Amethyst Engine and Draftroom share
 * the same canonical player IDs (MLB numeric IDs).
 *
 * Persists merged hitting + pitching splits per player (so two-way players
 * keep both `stats` / `projection` blobs), `positions[]` from split + bio
 * (including `TWP` → DH/SP), and `projection.pitching.innings` when pitching
 * exists — matching what the valuation catalog reads (`PLAYER_CATALOG_LEAN_SELECT`).
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
import { resolveMlbTeamAbbrev } from "../src/lib/mlbTeamResolve";
import Player from "../src/models/Player";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI not set in .env");
  process.exit(1);
}

const MLB_API = "https://statsapi.mlb.com/api/v1";
// During the active MLB season (March–October) use the current year;
// before opening day fall back to the last completed season.
const now = new Date();
const month = now.getMonth() + 1; // 1-indexed
const SEASON = month >= 3 && month <= 10 ? now.getFullYear() : now.getFullYear() - 1;

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
  teamIdToAbbr: Map<number, string>
): Record<string, unknown> | null {
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

  const projection: Record<string, unknown> = {};
  if (agg.bat) {
    const stat = agg.bat.stat;
    projection.batting = {
      avg: String(stat.avg ?? ".000"),
      hr: Number(stat.homeRuns ?? 0),
      rbi: Number(stat.rbi ?? 0),
      runs: Number(stat.runs ?? 0),
      sb: Number(stat.stolenBases ?? 0),
    };
  }
  if (agg.pit) {
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

  const doc: Record<string, unknown> = {
    mlbId,
    name: agg.bat?.player.fullName ?? agg.pit?.player.fullName ?? bio?.fullName ?? "Unknown",
    team,
    position,
    age: calcAge(bio?.birthDate),
    value,
    tier: assignTier(value),
    stats,
    projection,
    outlook: "",
  };
  if (positions.length > 0) {
    doc.positions = positions;
  }
  return doc;
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

async function sync() {
  await mongoose.connect(MONGO_URI as string);
  console.log(`[MongoDB] Connected — syncing season ${SEASON}`);

  const [batJson, pitJson] = await Promise.all([
    fetchJson<{ stats: { splits: MlbStatSplit[] }[] }>(
      `${MLB_API}/stats?stats=season&group=hitting&season=${SEASON}&playerPool=ALL&limit=400&sportId=1`
    ),
    fetchJson<{ stats: { splits: MlbStatSplit[] }[] }>(
      `${MLB_API}/stats?stats=season&group=pitching&season=${SEASON}&playerPool=ALL&limit=300&sportId=1`
    ),
  ]);

  const batSplits = batJson.stats?.[0]?.splits ?? [];
  const pitSplits = pitJson.stats?.[0]?.splits ?? [];
  console.log(`[MLB API] ${batSplits.length} batting splits, ${pitSplits.length} pitching splits`);

  const teamsJson = await fetchJson<{ teams: { id: number; abbreviation: string }[] }>(
    `${MLB_API}/teams?sportId=1&season=${SEASON}`
  );
  const teamIdToAbbr = new Map<number, string>();
  for (const t of teamsJson.teams ?? []) {
    teamIdToAbbr.set(t.id, t.abbreviation);
  }
  console.log(`[MLB API] Loaded ${teamIdToAbbr.size} team abbreviations`);

  // Fetch bio data for all players
  const playerIds = [
    ...new Set([...batSplits.map((s) => s.player.id), ...pitSplits.map((s) => s.player.id)]),
  ].slice(0, 600);

  const bioMap = new Map<number, MlbPlayer>();
  try {
    const bioJson = await fetchJson<{ people: MlbPlayer[] }>(
      `${MLB_API}/people?personIds=${playerIds.join(",")}&hydrate=currentTeam`
    );
    for (const p of bioJson.people ?? []) bioMap.set(p.id, p);
    console.log(`[MLB API] Fetched bio for ${bioMap.size} players`);
  } catch (err) {
    console.warn("[MLB API] Bio fetch failed (non-fatal):", (err as Error).message);
  }

  /** Merge hitting + pitching splits per player so two-way rows keep both stat blobs and eligibilities. */
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

  const playerMap = new Map<number, Record<string, unknown>>();
  for (const [mlbId, agg] of aggMap) {
    const bio = bioMap.get(mlbId);
    const doc = buildPlayerDocFromAgg(mlbId, agg, bio, teamIdToAbbr);
    if (doc) playerMap.set(mlbId, doc);
  }

  // Assign ADP by value rank
  const players = [...playerMap.values()].sort(
    (a, b) => (b.value as number) - (a.value as number)
  );
  players.forEach((p, i) => { p.adp = i + 1; });

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
