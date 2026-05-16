import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import {
  ENGINE_CHECKPOINT_IDS,
  draftCheckpointFixturesAvailable,
  resolveDraftCheckpointFixturePath,
  type EngineCheckpointId,
} from "../src/lib/checkpointSlotReconciliation";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";

const mongoReady =
  Boolean(process.env.MONGO_URI) && draftCheckpointFixturesAvailable();

function loadCheckpoint(id: EngineCheckpointId) {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath(id), "utf8")
  );
  return buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
}

function curveMetrics(auctionValues: number[]) {
  const avs = [...auctionValues].sort((a, b) => b - a).slice(0, 75);
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;

  let maxAdjDrop = 0;
  let maxAdjPct = 0;
  for (let i = 1; i < avs.length; i++) {
    const drop = avs[i - 1]! - avs[i]!;
    maxAdjDrop = Math.max(maxAdjDrop, drop);
    if (avs[i - 1]! > 0) maxAdjPct = Math.max(maxAdjPct, drop / avs[i - 1]!);
  }

  const rounded = avs.map((v) => Math.round(v));
  let run = 1;
  let maxShelfLen = 1;
  for (let i = 1; i < rounded.length; i++) {
    if (rounded[i] === rounded[i - 1]) {
      run++;
      maxShelfLen = Math.max(maxShelfLen, run + 1);
    } else {
      run = 1;
    }
  }

  return {
    top1: avs[0] ?? 0,
    top10Avg: avg(avs.slice(0, 10)),
    countAt48: rounded.filter((v) => v === 48).length,
    maxAdjDrop,
    maxAdjPct,
    maxWholeDollarShelfLen: maxShelfLen,
  };
}

describe.skipIf(!mongoReady)(
  "adaptive tiered curve shape (Mongo + Draft fixtures)",
  () => {
    it("after_pick_10: no pathological cliff; tiered_soft smoothing applied", async () => {
      await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
      let pool;
      try {
        pool = await loadMongoCatalogForEngine(undefined);
      } finally {
        await mongoose.disconnect().catch(() => undefined);
      }

      const valuationPool = filterValuationUniverse(pool, {
        leagueScope: "Mixed",
      });
      const input = loadCheckpoint("after_pick_10");
      const poolInj = applyInjuryOverridesToPool(
        valuationPool,
        input.injury_overrides
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

      const resp = out.response;
      expect(resp.internal_allocation_mode).toBe("tiered_soft");
      expect(
        (resp.curve_guardrails_applied ?? []).some((g) =>
          g.includes("tiered_linear_blend")
        )
      ).toBe(true);

      const m = curveMetrics(resp.valuations.map((v) => v.auction_value));
      expect(m.maxAdjDrop).toBeLessThan(6.5);
      expect(m.maxAdjPct).toBeLessThan(0.42);
      expect(m.countAt48).toBe(0);
    }, 60_000);

    it("pre_draft: healthy top band without $48 plateau", async () => {
      await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
      let pool;
      try {
        pool = await loadMongoCatalogForEngine(undefined);
      } finally {
        await mongoose.disconnect().catch(() => undefined);
      }

      const input = loadCheckpoint("pre_draft");
      const poolInj = applyInjuryOverridesToPool(
        filterValuationUniverse(pool, { leagueScope: "Mixed" }),
        input.injury_overrides
      );
      const out = executeValuationWorkflow(poolInj, {
        ...input,
        deterministic: true,
        seed: 42,
        inflation_model: "replacement_slots_v2",
        auction_curve_model: "adaptive_surplus_v1",
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;

      const m = curveMetrics(out.response.valuations.map((v) => v.auction_value));
      expect(m.top1).toBeGreaterThan(30);
      expect(m.top1).toBeLessThan(45);
      expect(m.countAt48).toBeLessThan(3);
    }, 60_000);

    it.each([
      "after_pick_50",
      "after_pick_100",
      "after_pick_130",
      "finished_league",
    ] as const)("%s: no $48 plateau cluster in top 75", async (id) => {
      await mongoose.connect(process.env.MONGO_URI!, scriptMongoConnectOptions());
      let pool;
      try {
        pool = await loadMongoCatalogForEngine(undefined);
      } finally {
        await mongoose.disconnect().catch(() => undefined);
      }

      const input = loadCheckpoint(id);
      const poolInj = applyInjuryOverridesToPool(
        filterValuationUniverse(pool, { leagueScope: "Mixed" }),
        input.injury_overrides
      );
      const out = executeValuationWorkflow(poolInj, {
        ...input,
        deterministic: true,
        seed: 42,
        inflation_model: "replacement_slots_v2",
        auction_curve_model: "adaptive_surplus_v1",
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;

      const m = curveMetrics(out.response.valuations.map((v) => v.auction_value));
      expect(m.top1).toBeLessThan(48);
      expect(m.countAt48).toBeLessThan(3);
      expect(m.maxAdjDrop).toBeLessThan(8);
    }, 60_000);
  }
);
