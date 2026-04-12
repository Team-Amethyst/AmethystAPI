/**
 * Sync script — fetches live player data from the MLB Stats API and upserts
 * into the `players` collection so the Amethyst Engine and Draftroom share
 * the same canonical player IDs (MLB numeric IDs).
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

  // Build canonical player map — deduplicate by mlbId, keep higher value
  const playerMap = new Map<number, Record<string, unknown>>();

  for (const s of batSplits) {
    const value = calcBatterValue(s.stat);
    if (value <= 0) continue;
    const bio = bioMap.get(s.player.id);
    const stat = s.stat;
    playerMap.set(s.player.id, {
      mlbId: s.player.id,
      name: s.player.fullName,
      team: resolveMlbTeamAbbrev(s.team, bio?.currentTeam, teamIdToAbbr),
      position: s.position?.abbreviation ?? bio?.primaryPosition?.abbreviation ?? "OF",
      age: calcAge(bio?.birthDate),
      value,
      tier: assignTier(value),
      stats: {
        batting: {
          avg: String(stat.avg ?? ".000"),
          hr: Number(stat.homeRuns ?? 0),
          rbi: Number(stat.rbi ?? 0),
          runs: Number(stat.runs ?? 0),
          sb: Number(stat.stolenBases ?? 0),
          obp: String(stat.obp ?? ".000"),
          slg: String(stat.slg ?? ".000"),
        },
      },
      projection: {
        batting: {
          avg: String(stat.avg ?? ".000"),
          hr: Number(stat.homeRuns ?? 0),
          rbi: Number(stat.rbi ?? 0),
          runs: Number(stat.runs ?? 0),
          sb: Number(stat.stolenBases ?? 0),
        },
      },
      outlook: "",
    });
  }

  for (const s of pitSplits) {
    const value = calcPitcherValue(s.stat);
    if (value <= 0) continue;
    const bio = bioMap.get(s.player.id);
    const existing = playerMap.get(s.player.id);
    if (existing && (existing.value as number) >= value) continue; // keep batter value if higher
    const stat = s.stat;
    playerMap.set(s.player.id, {
      mlbId: s.player.id,
      name: s.player.fullName,
      team: resolveMlbTeamAbbrev(s.team, bio?.currentTeam, teamIdToAbbr),
      position: s.position?.abbreviation ?? bio?.primaryPosition?.abbreviation ?? "SP",
      age: calcAge(bio?.birthDate),
      value,
      tier: assignTier(value),
      stats: {
        pitching: {
          era: String(stat.era ?? "0.00"),
          whip: String(stat.whip ?? "0.00"),
          wins: Number(stat.wins ?? 0),
          saves: Number(stat.saves ?? 0),
          strikeouts: Number(stat.strikeOuts ?? 0),
          innings: String(stat.inningsPitched ?? "0"),
        },
      },
      projection: {
        pitching: {
          era: String(stat.era ?? "0.00"),
          whip: String(stat.whip ?? "0.00"),
          wins: Number(stat.wins ?? 0),
          saves: Number(stat.saves ?? 0),
          strikeouts: Number(stat.strikeOuts ?? 0),
        },
      },
      outlook: "",
    });
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
