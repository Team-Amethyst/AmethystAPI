/**
 * Empty 12-team boards: true economics vs explicit demo calibration flag.
 */
import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import {
  CALIBRATION_CATS_5X5,
  draftroomUiDefaultRoster,
} from "../src/lib/calibrationDraftroomFixture";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";

const mongoReady = Boolean(process.env.MONGO_URI);

async function loadPool() {
  await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
  let pool;
  try {
    pool = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
  return applyInjuryOverridesToPool(
    filterValuationUniverse(pool, { leagueScope: "Mixed" }),
    [],
  );
}

const baseInput = {
  schemaVersion: "1.0.0",
  roster_slots: draftroomUiDefaultRoster(),
  scoring_categories: CALIBRATION_CATS_5X5,
  total_budget: 260,
  num_teams: 12,
  league_scope: "Mixed" as const,
  drafted_players: [],
  scoring_format: "5x5" as const,
  inflation_model: "replacement_slots_v2" as const,
  auction_curve_model: "adaptive_surplus_v1" as const,
  deterministic: true,
  seed: 42,
};

describe.skipIf(!mongoReady)("fresh empty 12-team board", () => {
  it("without demo flag uses real-empty opening tiered economics (~$28+ tops)", async () => {
    const poolInj = await loadPool();
    const out = executeValuationWorkflow(poolInj, baseInput);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const res = out.response;
    expect(res.auction_curve_reason).toBe("fresh_empty_opening_tiered");
    expect((res.draftable_player_ids ?? []).length).toBeGreaterThan(150);

    const draftable = new Set(res.draftable_player_ids ?? []);
    const top = res.valuations
      .filter((v) => draftable.has(v.player_id))
      .sort((a, b) => b.auction_value - a.auction_value)[0]!;
    expect(top.auction_value).toBeGreaterThanOrEqual(28);
    expect(top.auction_value).toBeLessThanOrEqual(36);
  }, 90_000);

  it("with stage3b_demo_v1 trims open slot demand to 113", async () => {
    const poolInj = await loadPool();
    const out = executeValuationWorkflow(poolInj, {
      ...baseInput,
      opening_board_calibration: "stage3b_demo_v1",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.response.remaining_slots).toBe(113);
    expect((out.response.draftable_player_ids ?? []).length).toBe(113);
  }, 90_000);
});
