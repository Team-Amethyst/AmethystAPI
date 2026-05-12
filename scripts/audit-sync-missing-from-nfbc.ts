/**
 * Read-only audit: why NFBC-listed MLB players are absent from Mongo `players`.
 *
 * Replays the MLB Stats API queries and `aggregatePositiveSplits` / value gates from
 * `scripts/sync-players.ts` without writing Mongo.
 *
 * Run:
 *   pnpm exec ts-node --project tsconfig.scripts.json scripts/audit-sync-missing-from-nfbc.ts
 */
import axios from "axios";
import dotenv from "dotenv";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import mongoose from "mongoose";

import { calcBatterValue, calcPitcherValue } from "../src/lib/mlbSyncFormulas";
import Player from "../src/models/Player";
import { resolveViaMlbSearch } from "./lib/draftPlayerIdResolve";

dotenv.config();

const ROOT = path.resolve(__dirname, "..");
const MLB_API = "https://statsapi.mlb.com/api/v1";
const LAST_COMPLETED_SEASON = new Date().getFullYear() - 1;

type MlbStatSplit = {
  player: { id: number; fullName: string };
  team?: { id?: number; abbreviation?: string };
  position?: { abbreviation: string };
  stat: Record<string, string | number>;
};

type PreviewMatch = {
  kind?: string;
  vendor?: {
    name: string;
    team: string;
    position: string;
    adp: number;
    mlb_id?: number | null;
  };
};

type AbsenceReason =
  | "missing_due_to_api_limit"
  | "missing_due_to_no_prior_season_stats"
  | "missing_due_to_value_gate"
  | "missing_due_to_projection_gate"
  | "missing_due_to_roster_status"
  | "missing_due_to_minors_prospect"
  | "missing_due_to_free_agent_non_roster"
  | "unknown";

function aggregatePositiveSplitsLikeSync(
  batSplits: MlbStatSplit[],
  pitSplits: MlbStatSplit[]
): Set<number> {
  const ids = new Set<number>();
  for (const s of batSplits) {
    if (calcBatterValue(s.stat) > 0) ids.add(s.player.id);
  }
  for (const s of pitSplits) {
    if (calcPitcherValue(s.stat) > 0) ids.add(s.player.id);
  }
  return ids;
}

function findSplit(splits: MlbStatSplit[], mlbId: number): MlbStatSplit | undefined {
  return splits.find((s) => s.player.id === mlbId);
}

async function fetchJson<T>(url: string): Promise<T> {
  const { data } = await axios.get<T>(url, { timeout: 60_000 });
  return data;
}

async function fetchSeasonSplitsForYear(season: number): Promise<{
  batSplits: MlbStatSplit[];
  pitSplits: MlbStatSplit[];
}> {
  const batUrl = `${MLB_API}/stats?stats=season&group=hitting&season=${season}&playerPool=ALL&limit=400&sportId=1`;
  const pitUrl = `${MLB_API}/stats?stats=season&group=pitching&season=${season}&playerPool=ALL&limit=300&sportId=1`;
  const [batJson, pitJson] = await Promise.all([
    fetchJson<{ stats: { splits: MlbStatSplit[] }[] }>(batUrl),
    fetchJson<{ stats: { splits: MlbStatSplit[] }[] }>(pitUrl),
  ]);
  const batSplits = batJson.stats?.[0]?.splits ?? [];
  const pitSplits = pitJson.stats?.[0]?.splits ?? [];
  return { batSplits, pitSplits };
}

async function fetchPeople(mlbId: number): Promise<{
  active?: boolean;
  primaryPosition?: { abbreviation?: string };
  currentTeam?: { id?: number; name?: string };
}> {
  const url = `${MLB_API}/people/${mlbId}?hydrate=currentTeam`;
  const data = await fetchJson<{ people: any[] }>(url);
  const p = data.people?.[0] ?? {};
  return {
    active: p.active,
    primaryPosition: p.primaryPosition
      ? { abbreviation: p.primaryPosition.abbreviation }
      : undefined,
    currentTeam: p.currentTeam ? { id: p.currentTeam.id, name: p.currentTeam.name } : undefined,
  };
}

function classifyAbsence(args: {
  inBatAnchor: boolean;
  inPitAnchor: boolean;
  inBatAny: boolean;
  inPitAny: boolean;
  inAgg: boolean;
  batValAnchor: number;
  pitValAnchor: number;
}): AbsenceReason | "sync_universe_positive_value" {
  if (args.inAgg) return "sync_universe_positive_value";

  if (args.inBatAnchor || args.inPitAnchor) {
    if (args.batValAnchor <= 0 && args.pitValAnchor <= 0) {
      return "missing_due_to_value_gate";
    }
  }

  if (!args.inBatAnchor && !args.inPitAnchor) {
    if (args.inBatAny || args.inPitAny) {
      return "missing_due_to_api_limit";
    }
    return "missing_due_to_no_prior_season_stats";
  }

  return "unknown";
}

function parseArgs(argv: string[]): { previewPath: string; topN: number } {
  const a = argv.slice(2);
  let previewPath = path.join(ROOT, "tmp/nfbc-data-mongo-preview.json");
  let topN = 50;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--preview" && a[i + 1]) previewPath = path.resolve(ROOT, a[++i]!);
    else if (a[i] === "--top" && a[i + 1]) {
      const n = Number(a[++i]!);
      if (Number.isFinite(n) && n > 0 && n <= 500) topN = Math.trunc(n);
    }
  }
  return { previewPath, topN };
}

async function main(): Promise<void> {
  const { previewPath, topN } = parseArgs(process.argv);
  if (!existsSync(previewPath)) {
    console.error(
      `Preview not found: ${previewPath}\n` +
        `Generate one, e.g.:\n` +
        `  pnpm market-adp-preview -- --source nfbc-data --mongo --out tmp/nfbc-data-mongo-preview.json\n` +
        `  pnpm market-adp-preview -- --source nfbc-data --out tmp/nfbc-data-preview.json\n` +
        `Then: pnpm exec ts-node --project tsconfig.scripts.json scripts/audit-sync-missing-from-nfbc.ts -- --preview <path>`
    );
    process.exit(1);
  }
  const preview = JSON.parse(readFileSync(previewPath, "utf8")) as { matches: PreviewMatch[] };

  const unmatched = (preview.matches ?? [])
    .filter((m) => m && m.kind === "unmatched_vendor" && m.vendor && Number.isFinite(m.vendor.adp))
    .sort((a, b) => (a.vendor!.adp ?? 0) - (b.vendor!.adp ?? 0))
    .slice(0, topN);

  const last = LAST_COMPLETED_SEASON;
  const seasons = [last, last - 1, last - 2] as const;
  console.log(
    JSON.stringify(
      {
        anchor_season: last,
        seasons_fetched: seasons,
        hitting_url_template: `${MLB_API}/stats?stats=season&group=hitting&season={season}&playerPool=ALL&limit=400&sportId=1`,
        pitching_url_template: `${MLB_API}/stats?stats=season&group=pitching&season={season}&playerPool=ALL&limit=300&sportId=1`,
        people_url_template: `${MLB_API}/people/{id}?hydrate=currentTeam`,
        note: "sync-players builds aggMap ONLY from anchor-year splits, after per-split calcBatterValue/calcPitcherValue > 0 filter (aggregatePositiveSplits).",
      },
      null,
      2
    )
  );

  const perYear = await Promise.all(seasons.map((se) => fetchSeasonSplitsForYear(se)));
  const anchorBat = perYear[0]!.batSplits;
  const anchorPit = perYear[0]!.pitSplits;
  const aggIds = aggregatePositiveSplitsLikeSync(anchorBat, anchorPit);

  const yearSplits: { season: number; bat: MlbStatSplit[]; pit: MlbStatSplit[] }[] = [];
  for (let i = 0; i < seasons.length; i++) {
    yearSplits.push({
      season: seasons[i]!,
      bat: perYear[i]!.batSplits,
      pit: perYear[i]!.pitSplits,
    });
  }

  const rows: any[] = [];
  const summary = {
    top_n: unmatched.length,
    anchor_bat_split_count: anchorBat.length,
    anchor_pit_split_count: anchorPit.length,
    agg_map_size: aggIds.size,
    resolved_mlb_id: 0,
    active_mlb: 0,
    in_anchor_bat_split: 0,
    in_anchor_pit_split: 0,
    in_agg_map: 0,
    in_mongo: 0,
    dropped_by_value_gate_on_anchor_split: 0,
    not_in_anchor_but_in_prior_year_split: 0,
    not_in_any_year_split: 0,
    absence_reason_counts: {} as Record<string, number>,
  };

  const uri = process.env.MONGO_URI;
  const mongoIds = new Set<number>();

  for (const m of unmatched) {
    const v = m.vendor!;
    const res = await resolveViaMlbSearch(v.name, v.team);
    if (!res) {
      rows.push({
        vendor: { name: v.name, team: v.team, position: v.position, adp: v.adp },
        resolved: null,
        absence_reason: "unknown",
        note: "MLB people search returned no resolvable id",
      });
      summary.absence_reason_counts["unknown"] =
        (summary.absence_reason_counts["unknown"] ?? 0) + 1;
      continue;
    }

    summary.resolved_mlb_id++;
    const mlbId = res.mlbId;
    mongoIds.add(mlbId);

    const people = await fetchPeople(mlbId);
    if (people.active) summary.active_mlb++;

    const batA = findSplit(anchorBat, mlbId);
    const pitA = findSplit(anchorPit, mlbId);
    const inBatA = !!batA;
    const inPitA = !!pitA;
    if (inBatA) summary.in_anchor_bat_split++;
    if (inPitA) summary.in_anchor_pit_split++;

    const batValA = batA ? calcBatterValue(batA.stat) : 0;
    const pitValA = pitA ? calcPitcherValue(pitA.stat) : 0;

    if (aggIds.has(mlbId)) summary.in_agg_map++;

    if ((inBatA || inPitA) && batValA <= 0 && pitValA <= 0) {
      summary.dropped_by_value_gate_on_anchor_split++;
    }

    let inAnyOther = false;
    let inAny = false;
    for (const ys of yearSplits) {
      const b = findSplit(ys.bat, mlbId);
      const p = findSplit(ys.pit, mlbId);
      if (b || p) inAny = true;
      if (ys.season !== last && (b || p)) inAnyOther = true;
    }
    if (!inBatA && !inPitA && inAnyOther) summary.not_in_anchor_but_in_prior_year_split++;
    if (!inAny) summary.not_in_any_year_split++;

    const reasonBase = classifyAbsence({
      inBatAnchor: inBatA,
      inPitAnchor: inPitA,
      inBatAny: yearSplits.some((ys) => !!findSplit(ys.bat, mlbId)),
      inPitAny: yearSplits.some((ys) => !!findSplit(ys.pit, mlbId)),
      inAgg: aggIds.has(mlbId),
      batValAnchor: batValA,
      pitValAnchor: pitValA,
    });

    const absenceReason =
      people.active === false ? "missing_due_to_free_agent_non_roster" : reasonBase;

    summary.absence_reason_counts[absenceReason] =
      (summary.absence_reason_counts[absenceReason] ?? 0) + 1;

    rows.push({
      vendor: { name: v.name, team: v.team, position: v.position, adp: v.adp },
      resolved: { mlbId: res.mlbId, method: res.method, canonicalName: res.canonicalName },
      mlb_people: people,
      anchor_season: last,
      in_anchor_bat_split: inBatA,
      in_anchor_pit_split: inPitA,
      batVal_anchor: batValA,
      pitVal_anchor: pitValA,
      in_agg_map: aggIds.has(mlbId),
      absence_reason: absenceReason,
    });
  }

  if (uri) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30_000 });
    try {
      const ids = [...mongoIds];
      const found = await Player.find({ mlbId: { $in: ids } }, { mlbId: 1 }).lean();
      const foundSet = new Set(found.map((d: any) => d.mlbId).filter((x: any) => typeof x === "number"));
      for (const r of rows) {
        const mid = r.resolved?.mlbId;
        if (typeof mid === "number" && foundSet.has(mid)) {
          r.in_mongo = true;
          summary.in_mongo++;
        } else {
          r.in_mongo = false;
        }
      }
    } finally {
      await mongoose.disconnect().catch(() => undefined);
    }
  } else {
    for (const r of rows) {
      r.in_mongo = null;
    }
  }

  const outPath = path.join(ROOT, `tmp/audit-sync-missing-from-nfbc-top${topN}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2), "utf8");

  console.log("\n=== SUMMARY ===\n");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
