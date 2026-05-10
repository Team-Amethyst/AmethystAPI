/**
 * Read-only Mongo audit: projection field population rates for valuation stats.
 * Usage: ts-node --project tsconfig.scripts.json scripts/stat-category-mongo-coverage.ts
 * Requires MONGO_URI (no writes).
 */
import "dotenv/config";
import mongoose from "mongoose";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { getProjectionSection, toNum } from "../src/services/baselineProjectionStats";

function hasBatting(p: { projection?: unknown }): boolean {
  const proj = p.projection as Record<string, unknown> | undefined;
  const b = proj?.batting;
  return b != null && typeof b === "object" && Object.keys(b as object).length > 0;
}

function hasPitching(p: { projection?: unknown }): boolean {
  const proj = p.projection as Record<string, unknown> | undefined;
  const pit = proj?.pitching;
  return pit != null && typeof pit === "object" && Object.keys(pit as object).length > 0;
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI required");
    process.exit(1);
  }
  await mongoose.connect(uri);
  let players: Awaited<ReturnType<typeof loadMongoCatalogForEngine>>;
  try {
    players = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const nb = players.filter(hasBatting).length;
  const np = players.filter(hasPitching).length;

  type FieldAgg = { populated: number; nonzeroCounting: number };
  const batFields: Record<string, FieldAgg> = {
    runs: { populated: 0, nonzeroCounting: 0 },
    hr: { populated: 0, nonzeroCounting: 0 },
    rbi: { populated: 0, nonzeroCounting: 0 },
    sb: { populated: 0, nonzeroCounting: 0 },
    avg: { populated: 0, nonzeroCounting: 0 },
    obp: { populated: 0, nonzeroCounting: 0 },
    slg: { populated: 0, nonzeroCounting: 0 },
    ops: { populated: 0, nonzeroCounting: 0 },
    totalBases: { populated: 0, nonzeroCounting: 0 },
    atBats: { populated: 0, nonzeroCounting: 0 },
    plateAppearances: { populated: 0, nonzeroCounting: 0 },
    ab: { populated: 0, nonzeroCounting: 0 },
    pa: { populated: 0, nonzeroCounting: 0 },
  };

  const pitFields: Record<string, FieldAgg> = {
    wins: { populated: 0, nonzeroCounting: 0 },
    saves: { populated: 0, nonzeroCounting: 0 },
    holds: { populated: 0, nonzeroCounting: 0 },
    strikeouts: { populated: 0, nonzeroCounting: 0 },
    era: { populated: 0, nonzeroCounting: 0 },
    whip: { populated: 0, nonzeroCounting: 0 },
    qualityStarts: { populated: 0, nonzeroCounting: 0 },
    innings: { populated: 0, nonzeroCounting: 0 },
    inningsPitched: { populated: 0, nonzeroCounting: 0 },
    ip: { populated: 0, nonzeroCounting: 0 },
  };

  for (const p of players) {
    const b = getProjectionSection(p, "batting");
    const pit = getProjectionSection(p, "pitching");

    const bump = (field: keyof typeof batFields, raw: unknown, isRate: boolean) => {
      if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
        batFields[field].populated++;
        if (isRate) {
          if (Math.abs(toNum(raw)) > 1e-9) batFields[field].nonzeroCounting++;
        } else if (toNum(raw) !== 0) batFields[field].nonzeroCounting++;
      }
    };

    if (hasBatting(p)) {
      bump("runs", b.runs, false);
      bump("hr", b.hr, false);
      bump("rbi", b.rbi, false);
      bump("sb", b.sb, false);
      bump("avg", b.avg, true);
      bump("obp", (b as Record<string, unknown>).obp, true);
      bump("slg", (b as Record<string, unknown>).slg, true);
      bump("ops", (b as Record<string, unknown>).ops, true);
      bump("totalBases", (b as Record<string, unknown>).totalBases, false);
      bump("atBats", (b as Record<string, unknown>).atBats, false);
      bump(
        "ab",
        (b as Record<string, unknown>).ab ?? (b as Record<string, unknown>).atBats,
        false
      );
      bump("plateAppearances", (b as Record<string, unknown>).plateAppearances, false);
      bump("pa", (b as Record<string, unknown>).pa, false);
    }

    const bumpP = (field: keyof typeof pitFields, raw: unknown, isRate: boolean) => {
      if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
        pitFields[field].populated++;
        if (isRate) {
          if (Math.abs(toNum(raw)) > 1e-9) pitFields[field].nonzeroCounting++;
        } else if (toNum(raw) !== 0) pitFields[field].nonzeroCounting++;
      }
    };

    if (hasPitching(p)) {
      bumpP("wins", pit.wins, false);
      bumpP("saves", pit.saves, false);
      bumpP("holds", (pit as Record<string, unknown>).holds, false);
      bumpP("strikeouts", pit.strikeouts, false);
      bumpP("era", pit.era, true);
      bumpP("whip", pit.whip, true);
      bumpP("qualityStarts", (pit as Record<string, unknown>).qualityStarts, false);
      bumpP("innings", pit.innings, false);
      bumpP("inningsPitched", (pit as Record<string, unknown>).inningsPitched, false);
      bumpP("ip", (pit as Record<string, unknown>).ip, false);
    }
  }

  function pct(num: number, den: number): string {
    return den === 0 ? "0.0" : ((100 * num) / den).toFixed(1);
  }

  const out = {
    catalogRows: players.length,
    battingSectionRows: nb,
    pitchingSectionRows: np,
    batting: Object.fromEntries(
      Object.entries(batFields).map(([k, v]) => [
        k,
        {
          pct_populated_of_batting_rows: pct(v.populated, nb),
          pct_nonzeroish_of_batting_rows: pct(v.nonzeroCounting, nb),
          populated: v.populated,
          nonzeroish: v.nonzeroCounting,
        },
      ])
    ),
    pitching: Object.fromEntries(
      Object.entries(pitFields).map(([k, v]) => [
        k,
        {
          pct_populated_of_pitching_rows: pct(v.populated, np),
          pct_nonzeroish_of_pitching_rows: pct(v.nonzeroCounting, np),
          populated: v.populated,
          nonzeroish: v.nonzeroCounting,
        },
      ])
    ),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
