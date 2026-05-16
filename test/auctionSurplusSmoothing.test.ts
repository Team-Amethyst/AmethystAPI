import { describe, expect, it } from "vitest";
import {
  blendSurplusDollarMaps,
  buildLinearSurplusDollars,
  normalizeSurplusMap,
  resolveSurplusSmoothingConfig,
  smoothSurplusAlongBasisRank,
} from "../src/services/auctionSurplusSmoothing";
import { buildTieredSurplusDollars } from "../src/services/auctionCurveModel";
import {
  allocateSurplusForCurve,
  resolveAuctionCurveForLeague,
  previewLinearSurplusAuction,
} from "../src/services/auctionCurveResolver";

describe("buildLinearSurplusDollars", () => {
  it("conserves surplus cash", () => {
    const ids = ["a", "b", "c", "d"];
    const sb = new Map(ids.map((id, i) => [id, 60 - i]));
    const surplusCash = 1000;
    const linear = buildLinearSurplusDollars({
      surplusCash,
      draftablePlayerIds: ids,
      surplusBasisById: sb,
    });
    let sum = 0;
    for (const v of linear.values()) sum += v;
    expect(sum).toBeCloseTo(surplusCash, 4);
  });
});

describe("smoothSurplusAlongBasisRank", () => {
  it("reduces a sharp starter/depth cliff while conserving mass", () => {
    const n = 200;
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const sb = new Map(ids.map((id, i) => [id, 70 - i * 0.05]));
    const surplusCash = 1036;
    const tiered = buildTieredSurplusDollars({
      surplusCash,
      draftablePlayerIds: ids,
      surplusBasisById: sb,
    });
    const linear = buildLinearSurplusDollars({
      surplusCash,
      draftablePlayerIds: ids,
      surplusBasisById: sb,
    });
    const blended = blendSurplusDollarMaps(
      tiered.dollarsByPlayerId,
      linear,
      0.52
    );
    const normalized = normalizeSurplusMap(blended, surplusCash);
    const cfg = resolveSurplusSmoothingConfig("tiered_soft", "mid_draft")!;
    const { dollarsByPlayerId } = smoothSurplusAlongBasisRank({
      dollarsByPlayerId: normalized,
      surplusCash,
      draftablePlayerIds: ids,
      surplusBasisById: sb,
      config: cfg,
    });

    const bySb = [...ids]
      .map((id) => ({
        id,
        sb: sb.get(id) ?? 0,
        d: dollarsByPlayerId.get(id) ?? 0,
      }))
      .sort((a, b) => b.sb - a.sb);

    let maxDrop = 0;
    for (let i = 1; i < 75; i++) {
      const drop = bySb[i - 1]!.d - bySb[i]!.d;
      if (drop > maxDrop) maxDrop = drop;
    }
    expect(maxDrop).toBeLessThan(4);

    let sum = 0;
    for (const v of dollarsByPlayerId.values()) sum += v;
    expect(sum).toBeCloseTo(surplusCash, 0);
  });
});

describe("allocateSurplusForCurve smoothing", () => {
  it("mid-draft tiered_soft does not produce a 9+ dollar adjacent surplus cliff in top 75", () => {
    const n = 536;
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const sb = new Map(ids.map((id, i) => [id, 70 - i * 0.025]));
    const surplusCash = 1036;
    const minBid = 1;
    const preview = previewLinearSurplusAuction(ids, sb, 0.25, minBid);
    const state = {
      activeSlotCapacity: 189,
      activeRosteredCount: 86,
      remainingActiveSlots: 103,
      openSlotRatio: 103 / 189,
      keeperCount: 76,
      draftedAuctionCount: 10,
      minTaxiPoolCount: 40,
      numTeams: 9,
      totalBudgetPerTeam: 260,
      leagueAuctionDollars: 2340,
      remainingAuctionDollars: 1139,
      minimumReserveDollars: 103,
      allocatableSurplusDollars: surplusCash,
      totalSurplusMass: 5200,
      inflationRaw: 0.2,
      inflationFactor: 0.25,
      draftablePoolSize: n,
    };
    const resolution = resolveAuctionCurveForLeague({
      requestedModel: "adaptive_surplus_v1",
      state,
      linearPreview: preview,
    });
    expect(resolution.internalMode).toBe("tiered_soft");

    const alloc = allocateSurplusForCurve({
      resolution,
      surplusCash,
      minBid,
      draftablePlayerIds: ids,
      surplusBasisById: sb,
      state,
    });

    expect(alloc.guardrailsApplied.some((g) => g.includes("tiered_linear_blend"))).toBe(
      true
    );

    const auctionVals = [...ids]
      .map((id) => minBid + (alloc.dollarsByPlayerId.get(id) ?? 0))
      .sort((a, b) => b - a)
      .slice(0, 75);

    let maxAdjDrop = 0;
    for (let i = 1; i < auctionVals.length; i++) {
      maxAdjDrop = Math.max(maxAdjDrop, auctionVals[i - 1]! - auctionVals[i]!);
    }
    expect(maxAdjDrop).toBeLessThan(6.5);
    expect(auctionVals[0]!).toBeLessThan(48);

    let sum = 0;
    for (const v of alloc.dollarsByPlayerId.values()) sum += v;
    expect(sum).toBeCloseTo(surplusCash, 0);
  });
});
