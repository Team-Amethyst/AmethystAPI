/**
 * One-off: replicate `loadMongoCatalogForEngine` exactly to see what data
 * arrives at the baseline pipeline. Specifically, query
 *   Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean()
 * and report whether the `projection.batting/pitching` blobs are present on
 * the same top-of-board players the live engine returns at `$10` everywhere.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import Player from "../src/models/Player";
import { PLAYER_CATALOG_LEAN_SELECT } from "../src/lib/playerCatalogProjection";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import { isValuationEligibleCatalogRow } from "../src/lib/catalogRowClassification";

dotenv.config();

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  await mongoose.connect(uri, scriptMongoConnectOptions());

  const t0 = Date.now();
  const raw = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean();
  const t1 = Date.now();
  console.log(`raw find: ${raw.length} rows in ${t1 - t0}ms`);

  const normalized = normalizeCatalogPlayers(raw as unknown[], () => undefined);
  const valuationRows = normalized.filter((p) => isValuationEligibleCatalogRow(p));
  console.log(
    `after normalize: ${normalized.length} rows; after eligibility filter: ${valuationRows.length} rows`
  );

  const idsToCheck = [434378, 445276, 453286, 592450, 660271, 669373];
  for (const id of idsToCheck) {
    const row = valuationRows.find((r: any) => r.mlbId === id);
    if (!row) {
      console.log(`mlbId=${id}: NOT IN valuationRows (filtered out)`);
      continue;
    }
    const proj: any = row.projection ?? null;
    console.log(
      JSON.stringify({
        mlbId: row.mlbId,
        name: row.name,
        position: row.position,
        team: row.team,
        age: row.age,
        depthChartPosition: row.depthChartPosition,
        value: row.value,
        catalogValuationTier: row.catalogValuationTier,
        projection_present: proj != null,
        projection_keys: proj ? Object.keys(proj) : [],
        batting_present: !!proj?.batting,
        batting_hr: proj?.batting?.hr ?? null,
        pitching_present: !!proj?.pitching,
        pitching_strikeouts: proj?.pitching?.strikeouts ?? null,
      })
    );
  }

  const projPresent = valuationRows.filter(
    (r: any) =>
      r.projection != null &&
      (r.projection.batting?.hr != null || r.projection.pitching?.strikeouts != null)
  );
  console.log(
    `valuationRows with batting.hr or pitching.strikeouts populated: ${projPresent.length}/${valuationRows.length}`
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
