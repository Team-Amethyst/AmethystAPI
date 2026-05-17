/**
 * Stage 2 hybrid calibration regressions (pre_draft fixture + Mongo catalog).
 */
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
import { sumAuctionValueForDraftablePool } from "../src/lib/rosterUniverseValuationCalibration";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import {
  applyHybridDraftableSurplusBasis,
} from "../src/services/replacementSlotsV2Helpers";
import { DEFAULT_HYBRID_SURPLUS_CALIBRATION } from "../src/services/replacementSlotsV2Config";

const mongoReady =
  Boolean(process.env.MONGO_URI) && draftCheckpointFixturesAvailable();

const TRACKED = [
  "Aaron Judge",
  "Julio Rodríguez",
  "Tarik Skubal",
  "Bobby Witt Jr.",
  "José Ramírez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Anthony Volpe",
  "Spencer Jones",
  "Will Warren",
  "Camilo Doval",
] as const;

function loadPreDraft() {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8"),
  );
  return buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
}

describe("hybrid lift cap", () => {
  it("never sets surplus_basis above hybridCap", () => {
    const assigned = new Set(["elite"]);
    const out = applyHybridDraftableSurplusBasis({
      surplusBasisById: new Map([["elite", 1]]),
      assignedIds: assigned,
      baselineById: new Map([["elite", 70]]),
      targetTotalMass: 1,
      strengthFloorBaselines: [30, 40, 50, 60, 70],
      playerTokensById: new Map([["elite", ["3B"]]]),
      categoryProjectionById: new Map([["elite", 45]]),
      assignedSlotById: new Map([["elite", "3B"]]),
      calibration: DEFAULT_HYBRID_SURPLUS_CALIBRATION,
    });
    const sb = out.surplusBasisById.get("elite") ?? 0;
    expect(sb).toBeLessThanOrEqual(
      (DEFAULT_HYBRID_SURPLUS_CALIBRATION.hybridTotalCeiling ?? 48) + 1e-9,
    );
    expect(sb).toBeGreaterThan(1);
  });
});

describe.skipIf(!mongoReady)("Stage 2 pre_draft integration", () => {
  it("preserves draftable pool, UTIL replacement, and curve guardrails", async () => {
    await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
    let pool;
    try {
      pool = await loadMongoCatalogForEngine(undefined);
    } finally {
      await mongoose.disconnect().catch(() => undefined);
    }

    const input = loadPreDraft();
    const poolInj = applyInjuryOverridesToPool(
      filterValuationUniverse(pool, { leagueScope: input.league_scope }),
      input.injury_overrides,
    );
    const out = executeValuationWorkflow(poolInj, {
      ...input,
      deterministic: true,
      seed: 42,
      inflation_model: "replacement_slots_v2",
      auction_curve_model: "adaptive_surplus_v1",
      explain_valuation_rows: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const res = out.response;
    const repl = res.replacement_values_by_slot_or_position ?? {};
    expect(res.draftable_player_ids?.length ?? 0).toBe(113);
    expect(repl.UTIL ?? repl.Util ?? 0).toBeGreaterThan(50);

    const draftable = new Set(res.draftable_player_ids ?? []);
    const draftableVals = res.valuations
      .filter((v) => draftable.has(v.player_id))
      .map((v) => v.auction_value)
      .sort((a, b) => b - a);

    const plateau48 = draftableVals.filter(
      (v) => v >= 47.5 && v <= 48.5,
    ).length;
    expect(plateau48).toBe(0);
    expect(draftableVals.slice(75).filter((v) => v > 20).length).toBe(0);

    let cliff = 0;
    for (let i = 0; i < draftableVals.length - 1; i++) {
      if (
        draftableVals[i]! >= 15 &&
        draftableVals[i + 1]! <= 5 &&
        draftableVals[i]! - draftableVals[i + 1]! >= 10
      ) {
        cliff++;
      }
    }
    expect(cliff).toBe(0);

    const minBid = res.min_bid ?? 1;
    let surplusConservation = 0;
    for (const v of res.valuations) {
      if (!draftable.has(v.player_id)) continue;
      surplusConservation += Math.max(0, v.auction_value - minBid);
    }
    expect(Math.abs((res.surplus_cash ?? 0) - surplusConservation)).toBeLessThan(
      0.1,
    );
  }, 60_000);

  it("tracked elites: Ramírez/Vlad lifted, Spencer Jones no row, tail not in pool", async () => {
    await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
    let pool;
    try {
      pool = await loadMongoCatalogForEngine(undefined);
    } finally {
      await mongoose.disconnect().catch(() => undefined);
    }

    const input = loadPreDraft();
    const poolInj = applyInjuryOverridesToPool(
      filterValuationUniverse(pool, { leagueScope: input.league_scope }),
      input.injury_overrides,
    );
    const out = executeValuationWorkflow(poolInj, {
      ...input,
      deterministic: true,
      seed: 42,
      inflation_model: "replacement_slots_v2",
      auction_curve_model: "adaptive_surplus_v1",
      explain_valuation_rows: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const res = out.response;
    const draftable = new Set(res.draftable_player_ids ?? []);
    const byName = (n: string) => res.valuations.find((v) => v.name === n);

    const judge = byName("Aaron Judge");
    const julio = byName("Julio Rodríguez");
    const ramirez = byName("José Ramírez");
    const vlad = byName("Vladimir Guerrero Jr.");
    const witt = byName("Bobby Witt Jr.");
    const volpe = byName("Anthony Volpe");
    const warren = byName("Will Warren");
    const doval = byName("Camilo Doval");
    const spencer = byName("Spencer Jones");

    expect(judge?.auction_value ?? 0).toBeGreaterThanOrEqual(34);
    expect(julio?.auction_value ?? 0).toBeGreaterThanOrEqual(34);
    expect(ramirez?.valuation_explain?.surplus_basis ?? 0).toBeGreaterThan(10);
    expect(ramirez?.auction_value ?? 0).toBeGreaterThan(4);
    expect(vlad?.valuation_explain?.surplus_basis ?? 0).toBeGreaterThan(5);
    expect(witt?.valuation_explain?.surplus_basis ?? 0).toBeGreaterThan(10);
    expect(witt?.auction_value ?? 0).toBeGreaterThan(4);
    expect(vlad?.valuation_explain?.surplus_basis ?? 0).toBeGreaterThan(5);
    expect(witt?.valuation_explain?.surplus_basis ?? 0).toBeGreaterThan(10);
    expect(ramirez?.valuation_explain?.replacement_key_used).toBe("3B");
    expect(vlad?.valuation_explain?.replacement_key_used).toBe("1B");

    expect(spencer).toBeUndefined();
    if (volpe) {
      expect(volpe.auction_value).toBeLessThanOrEqual(15);
    }
    if (warren) {
      expect(draftable.has(warren.player_id)).toBe(false);
      expect(warren.auction_value).toBe(1);
    }
    if (doval) {
      expect(draftable.has(doval.player_id)).toBe(false);
      expect(doval.auction_value).toBe(1);
    }
  }, 60_000);
});
