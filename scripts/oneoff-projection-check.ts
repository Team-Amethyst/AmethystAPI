/**
 * One-off: read a handful of valuation-eligible players from production Mongo
 * and report whether their projection.batting/pitching blobs are populated.
 *
 * Purpose: prove (after `pnpm sync-players --confirm-universe-write`) that the
 * upstream data the Engine reads is no longer collapsed, independent of the
 * Engine's in-process catalog cache.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import Player from "../src/models/Player";

dotenv.config();

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  await mongoose.connect(uri, scriptMongoConnectOptions());

  // Sample by `value` desc so we look at the same rows the engine ranks at the top.
  const samples = await Player.find(
    { catalogKind: "mlb", catalogValuationTier: "valuation_eligible" },
    {
      mlbId: 1,
      name: 1,
      position: 1,
      value: 1,
      "projection.batting": 1,
      "projection.pitching": 1,
    }
  )
    .sort({ value: -1 })
    .limit(15)
    .lean();

  console.log(
    JSON.stringify(
      samples.map((p: any) => {
        const b = p?.projection?.batting ?? null;
        const pi = p?.projection?.pitching ?? null;
        return {
          mlbId: p.mlbId,
          name: p.name,
          position: p.position,
          catalog_value: p.value ?? null,
          batting_keys: b ? Object.keys(b).length : 0,
          batting_sample: b
            ? {
                hr: b.hr ?? null,
                runs: b.runs ?? null,
                rbi: b.rbi ?? null,
                avg: b.avg ?? null,
                sb: b.sb ?? null,
              }
            : null,
          pitching_keys: pi ? Object.keys(pi).length : 0,
          pitching_sample: pi
            ? {
                wins: pi.wins ?? null,
                strikeouts: pi.strikeouts ?? null,
                era: pi.era ?? null,
                whip: pi.whip ?? null,
                innings: pi.innings ?? null,
                saves: pi.saves ?? null,
              }
            : null,
        };
      }),
      null,
      2
    )
  );

  const totalEligible = await Player.countDocuments({
    catalogKind: "mlb",
    catalogValuationTier: "valuation_eligible",
  });
  const withBatting = await Player.countDocuments({
    catalogKind: "mlb",
    catalogValuationTier: "valuation_eligible",
    "projection.batting.hr": { $exists: true, $ne: null },
  });
  const withPitching = await Player.countDocuments({
    catalogKind: "mlb",
    catalogValuationTier: "valuation_eligible",
    "projection.pitching.strikeouts": { $exists: true, $ne: null },
  });
  console.log(
    JSON.stringify(
      {
        coverage: {
          valuation_eligible_total: totalEligible,
          with_projection_batting_hr: withBatting,
          with_projection_pitching_strikeouts: withPitching,
        },
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
