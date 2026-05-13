/**
 * One-off: compare what my local script reads vs what the live engine sees
 * for the players that appear at the TOP of the live engine's collapsed
 * response (Verlander/Jansen/Scherzer). If the local Mongo shows populated
 * `projection`/`age`/`depthChartPosition` for those same mlbIds while the
 * live engine reports them as null, we know the engine is reading from a
 * different Mongo (different MONGO_URI in App Runner env) or a stale replica.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import Player from "../src/models/Player";

dotenv.config();

const MLBS = [434378, 445276, 453286, 455119, 456781, 457705];

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  await mongoose.connect(uri, scriptMongoConnectOptions());

  const docs = await Player.find(
    { mlbId: { $in: MLBS } },
    {
      mlbId: 1,
      name: 1,
      team: 1,
      position: 1,
      age: 1,
      depthChartPosition: 1,
      catalogKind: 1,
      catalogValuationTier: 1,
      value: 1,
      "projection.batting": 1,
      "projection.pitching": 1,
    }
  ).lean();

  console.log(
    JSON.stringify(
      docs.map((d: any) => ({
        mlbId: d.mlbId,
        name: d.name,
        team: d.team,
        position: d.position,
        age: d.age,
        depthChartPosition: d.depthChartPosition,
        catalogKind: d.catalogKind,
        catalogValuationTier: d.catalogValuationTier,
        value: d.value,
        projection_batting_present: !!d?.projection?.batting,
        projection_pitching_present: !!d?.projection?.pitching,
        projection_batting_keys: d?.projection?.batting
          ? Object.keys(d.projection.batting).length
          : 0,
        projection_pitching_keys: d?.projection?.pitching
          ? Object.keys(d.projection.pitching).length
          : 0,
      })),
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
