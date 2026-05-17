/**
 * Compare canonical pre_draft keeper valuation paths (audit vs Draft-shaped flat body).
 *
 *   pnpm exec ts-node --project tsconfig.scripts.json scripts/research-valuation-diagnosis.ts
 */
import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { reconcileCheckpointSlotDemand } from "../src/lib/checkpointSlotReconciliation";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import type { NormalizedValuationInput } from "../src/types/brain";

const FIXTURE = resolveDraftCheckpointFixturePath("pre_draft");

function topRows(resp: { valuations: { name: string; player_id: string; auction_value: number; recommended_bid?: number }[] }, n = 10) {
  return [...resp.valuations]
    .sort((a, b) => b.auction_value - a.auction_value)
    .slice(0, n)
    .map((r) => ({
      name: r.name,
      player_id: r.player_id,
      auction_value: r.auction_value,
      recommended_bid: r.recommended_bid,
    }));
}

function run(label: string, input: NormalizedValuationInput, pool: Parameters<typeof executeValuationWorkflow>[0]) {
  const body = {
    ...input,
    inflation_model: "replacement_slots_v2" as const,
    auction_curve_model: "adaptive_surplus_v1" as const,
    deterministic: true,
    seed: 42,
  };
  const result = executeValuationWorkflow(pool, body, {}, {});
  if (!result.ok) throw new Error(`${label}: workflow failed`);
  const resp = result.response;
  const recon = reconcileCheckpointSlotDemand(body, {
    checkpoint_id: "pre_draft",
    engine_remaining_slots: resp.remaining_slots,
  });
  return {
    label,
    curve: {
      auction_curve_model: resp.auction_curve_model,
      auction_curve_reason: resp.auction_curve_reason,
      internal_allocation_mode: resp.internal_allocation_mode,
      remaining_slots: resp.remaining_slots,
      inflation_factor: resp.inflation_factor,
    },
    reconciliation: recon,
    top10: topRows(resp),
    judge: resp.valuations.find((v) => v.name.includes("Judge")),
    tatis: resp.valuations.find((v) => v.name.includes("Tatis")),
    jrod: resp.valuations.find((v) => v.name.includes("Rodr")),
  };
}

/** Draft `buildEngineValuationCalculateBodyFromFixture` shape (flat roster_slots array). */
function nestedToDraftFlatBody(nested: NormalizedValuationInput): NormalizedValuationInput {
  return {
    ...nested,
    drafted_players: nested.drafted_players,
    roster_slots: nested.roster_slots,
  };
}

/** Live Research path: no deterministic/seed (matches `buildValuationContext`). */
function stripDeterminism(input: NormalizedValuationInput): NormalizedValuationInput {
  return { ...input, deterministic: false, seed: undefined };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let pool;
  try {
    pool = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const valuationPool = filterValuationUniverse(pool, { leagueScope: nested.league_scope });
  const poolWithInjury = applyInjuryOverridesToPool(
    valuationPool,
    nested.injury_overrides,
  );
  const positionOverrides = positionOverridesFromRequest(nested.position_overrides);
  const basePlayers = scoringAwareBaselinePlayers(
    poolWithInjury,
    nested.scoring_format,
    nested.scoring_categories,
    nested.roster_slots,
    positionOverrides,
  );

  const results = [
    run("audit_nested_fixture", nested, basePlayers),
    run("draft_flat_same_data", nestedToDraftFlatBody(nested), basePlayers),
    run("live_like_no_deterministic", stripDeterminism(nested), basePlayers),
  ];

  console.log(JSON.stringify({ fixture: FIXTURE, results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
