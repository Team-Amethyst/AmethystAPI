import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import {
  draftCheckpointFixturesAvailable,
  resolveDraftCheckpointFixturePath,
} from "../src/lib/checkpointSlotReconciliation";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { DEFAULT_STAGE3B_CALIBRATION } from "../src/services/stage3bPitcherCalibration";

const mongoReady =
  Boolean(process.env.MONGO_URI) && draftCheckpointFixturesAvailable();

describe.skipIf(!mongoReady)("Stage 3b Woo integration", () => {
  it("raises marginal SP auction when surplus supports it", async () => {
    await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
    let pool;
    try {
      pool = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
    } finally {
      await mongoose.disconnect().catch(() => undefined);
    }

    const raw = JSON.parse(
      readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8"),
    );
    const input = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
    const poolInj = applyInjuryOverridesToPool(
      filterValuationUniverse(pool, { leagueScope: input.league_scope }),
      input.injury_overrides,
    );
    const out = executeValuationWorkflow(
      poolInj,
      {
        ...input,
        deterministic: true,
        seed: 42,
        inflation_model: "replacement_slots_v2",
        auction_curve_model: "adaptive_surplus_v1",
        stage3b_calibration: DEFAULT_STAGE3B_CALIBRATION,
      },
      {},
      {},
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const woo = out.response.valuations.find((v) => v.name === "Bryan Woo");
    const ryan = out.response.valuations.find((v) => v.name === "Joe Ryan");
    expect(woo?.auction_value ?? 0).toBeGreaterThanOrEqual(7.5);
    expect(ryan?.auction_value ?? 0).toBeGreaterThanOrEqual(6);
  });
});
