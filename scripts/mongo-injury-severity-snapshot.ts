/**
 * Mongo snapshot: injurySeverity histogram on `players` + join to one full-catalog valuation
 * (pre_draft fixture) for baseline_value / auction_value / injury fields on nonzero rows.
 *
 * **Read-only:** aggregation + `executeValuationWorkflow` only; no catalog writes. Writes JSON
 * to stdout (redirect to a file if needed).
 *
 *   pnpm exec ts-node --project tsconfig.scripts.json scripts/mongo-injury-severity-snapshot.ts
 *
 * Requires MONGO_URI. Set AMETHYST_SKIP_MLB_TEAM_HYDRATE=1 to avoid Stats API calls.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";

async function main() {
  const uri = process.env.MONGO_URI?.trim();
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const coll = mongoose.connection.collection("players");

  const total = await coll.countDocuments({});
  /** `{ injurySeverity: null }` also matches missing keys; split explicitly. */
  const missing = await coll.countDocuments({ injurySeverity: { $exists: false } });
  const nullish = await coll.countDocuments({
    $and: [{ injurySeverity: { $exists: true } }, { injurySeverity: null }],
  });
  const c0 = await coll.countDocuments({ injurySeverity: 0 });
  const c1 = await coll.countDocuments({ injurySeverity: 1 });
  const c2 = await coll.countDocuments({ injurySeverity: 2 });
  const c3 = await coll.countDocuments({ injurySeverity: 3 });

  const fixturePath = path.join(
    __dirname,
    "../test-fixtures/player-api/checkpoints/pre_draft.json"
  );
  const parsed = parseValuationRequest(
    JSON.parse(readFileSync(fixturePath, "utf8")) as object
  );
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.errors));
    process.exit(1);
  }

  const input = {
    ...parsed.normalized,
    deterministic: true,
    seed: 42,
    explain_valuation_rows: true,
  };

  const catalog = await loadMongoCatalogForEngine(undefined, {
    skipMlbHydration: process.env.AMETHYST_SKIP_MLB_TEAM_HYDRATE === "1",
  });

  const wf = executeValuationWorkflow(catalog, input);
  const valMap = new Map<
    string,
    {
      baseline_value: number;
      auction_value: number;
      injury_multiplier: number;
      injury_component?: number;
    }
  >();
  if (wf.ok) {
    for (const v of wf.response.valuations) {
      const bc = v.baseline_components;
      valMap.set(v.player_id, {
        baseline_value: v.baseline_value,
        auction_value: v.auction_value,
        injury_multiplier: bc?.injury_multiplier ?? 1,
        injury_component: bc?.injury_component,
      });
    }
  }

  const nonzeroDocs = await coll
    .find(
      { injurySeverity: { $in: [1, 2, 3] } },
      { projection: { mlbId: 1, name: 1, team: 1, position: 1, injurySeverity: 1 } }
    )
    .sort({ injurySeverity: -1, name: 1 })
    .toArray();

  const nonzero_players = nonzeroDocs.map((d) => {
    const rec = d as Record<string, unknown>;
    const mlbId = rec.mlbId;
    const pid =
      typeof mlbId === "number" && Number.isFinite(mlbId) ? String(Math.trunc(mlbId)) : null;
    const vals = pid ? valMap.get(pid) : undefined;
    return {
      player_id: pid,
      name: typeof rec.name === "string" ? rec.name : null,
      team: typeof rec.team === "string" ? rec.team : null,
      position: typeof rec.position === "string" ? rec.position : null,
      injurySeverity: rec.injurySeverity,
      injury_multiplier: vals?.injury_multiplier ?? null,
      baseline_value: vals?.baseline_value ?? null,
      auction_value: vals?.auction_value ?? null,
      injury_component: vals?.injury_component ?? null,
      valuation_row_found: Boolean(vals),
    };
  });

  const out = {
    valuation_ok: wf.ok,
    valuation_issues: wf.ok ? [] : wf.issues,
    total_players: total,
    injurySeverity_counts: {
      field_missing: missing,
      null: nullish,
      zero: c0,
      one: c1,
      two: c2,
      three: c3,
    },
    nonzero_injury_players: nonzero_players,
  };
  console.log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
