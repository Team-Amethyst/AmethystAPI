/**
 * Valuate using Draft-shaped mongo payload (player_ids, no deterministic).
 */
import "dotenv/config";
import { readFileSync } from "fs";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { getPlayerId } from "../src/lib/playerId";

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI");

  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8"),
  );
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let catalog;
  try {
    catalog = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect();
  }

  const pool = filterValuationUniverse(catalog, { leagueScope: nested.league_scope });
  const players = scoringAwareBaselinePlayers(
    applyInjuryOverridesToPool(pool, nested.injury_overrides),
    nested.scoring_format,
    nested.scoring_categories,
    nested.roster_slots,
    positionOverridesFromRequest(nested.position_overrides),
  );

  const playerIds = players.map((p) => getPlayerId(p));

  const variants = [
    { label: "audit_deterministic", deterministic: true, seed: 42, player_ids: undefined as string[] | undefined },
    { label: "live_like", deterministic: false, seed: undefined, player_ids: playerIds },
    { label: "live_like_deterministic", deterministic: true, seed: 42, player_ids: playerIds },
  ];

  for (const v of variants) {
    const body = {
      ...nested,
      inflation_model: "replacement_slots_v2" as const,
      auction_curve_model: "adaptive_surplus_v1" as const,
      deterministic: v.deterministic,
      seed: v.seed,
      player_ids: v.player_ids,
    };
    const r = executeValuationWorkflow(players, body, {}, {});
    if (!r.ok) throw new Error(v.label);
    const top = [...r.response.valuations]
      .sort((a, b) => b.auction_value - a.auction_value)
      .slice(0, 3)
      .map((x) => ({ name: x.name, av: x.auction_value }));
    const judge = r.response.valuations.find((x) => x.player_id === "592450");
    console.log(v.label, {
      curve: r.response.auction_curve_model,
      reason: r.response.auction_curve_reason,
      remaining: r.response.remaining_slots,
      factor: r.response.inflation_factor,
      top3: top,
      judge: judge?.auction_value,
    });
  }
}

main();
