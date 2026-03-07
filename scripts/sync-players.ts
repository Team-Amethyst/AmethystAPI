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
  currentTeam?: { abbreviation: string };
  primaryPosition?: { abbreviation: string };
  birthDate?: string;
}

interface MlbStatSplit {
  player: { id: number; fullName: string };
  team?: { abbreviation: string };
  position?: { abbreviation: string };
  stat: Record<string, string | number>;
}

function calcAge(birthDate?: string): number {
  if (!birthDate) return 0;
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function assignTier(value: number): number {
  if (value >= 40) return 1;
  if (value >= 25) return 2;
  if (value >= 15) return 3;
  if (value >= 5) return 4;
  return 5;
}

function calcBatterValue(stat: Record<string, string | number>): number {
  const hr = Number(stat.homeRuns ?? 0);
  const rbi = Number(stat.rbi ?? 0);
  const runs = Number(stat.runs ?? 0);
  const sb = Number(stat.stolenBases ?? 0);
  const avg = parseFloat(String(stat.avg ?? "0"));
  const ab = Number(stat.atBats ?? 0);
  if (ab < 100) return 0;
  const score =
    (hr - 18) * 2.8 +
    (rbi - 72) * 0.9 +
    (runs - 72) * 0.9 +
    (sb - 8) * 3.2 +
    (avg - 0.258) * ab * 3.5;
  return Math.round(Math.max(1, score * 0.28 + 15));
}

function calcPitcherValue(stat: Record<string, string | number>): number {
  const era = parseFloat(String(stat.era ?? "9"));
  const whip = parseFloat(String(stat.whip ?? "2"));
  const k = Number(stat.strikeOuts ?? 0);
  const w = Number(stat.wins ?? 0);
  const sv = Number(stat.saves ?? 0);
  const ip = parseFloat(String(stat.inningsPitched ?? "0"));
  if (ip < 20 && sv < 5) return 0;
  const score =
    (4.20 - era) * ip * 0.5 +
    (1.28 - whip) * ip * 1.2 +
    (k - 150) * 0.18 +
    (w - 9) * 2.5 +
    sv * 2.8;
  return Math.round(Math.max(1, score * 0.22 + 12));
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
      team: s.team?.abbreviation ?? bio?.currentTeam?.abbreviation ?? "--",
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
      team: s.team?.abbreviation ?? bio?.currentTeam?.abbreviation ?? "--",
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
