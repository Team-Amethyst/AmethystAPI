import { describe, expect, it } from "vitest";
import {
  applySurplusGuardrails,
  classifyLeagueBoardPhase,
  computeSurplusGuardrailCaps,
  isLinearCurveOverCompressedState,
  previewLinearSurplusAuction,
  resolveAuctionCurveForLeague,
} from "../src/services/auctionCurveResolver";
import { buildTieredSurplusDollars } from "../src/services/auctionCurveModel";

function keeperPreDraftState() {
  return {
    activeSlotCapacity: 189,
    activeRosteredCount: 76,
    remainingActiveSlots: 113,
    openSlotRatio: 113 / 189,
    keeperCount: 76,
    draftedAuctionCount: 0,
    minTaxiPoolCount: 40,
    numTeams: 9,
    totalBudgetPerTeam: 260,
    leagueAuctionDollars: 2340,
    remainingAuctionDollars: 1422,
    minimumReserveDollars: 113,
    allocatableSurplusDollars: 1309,
    totalSurplusMass: 6635,
    inflationRaw: 0.2,
    inflationFactor: 0.25,
    draftablePoolSize: 113,
  };
}

function freshState() {
  return {
    activeSlotCapacity: 189,
    activeRosteredCount: 0,
    remainingActiveSlots: 189,
    openSlotRatio: 1,
    keeperCount: 0,
    draftedAuctionCount: 0,
    minTaxiPoolCount: 0,
    numTeams: 9,
    totalBudgetPerTeam: 260,
    leagueAuctionDollars: 2340,
    remainingAuctionDollars: 2340,
    minimumReserveDollars: 189,
    allocatableSurplusDollars: 2151,
    totalSurplusMass: 421,
    inflationRaw: 5.1,
    inflationFactor: 3,
    draftablePoolSize: 189,
  };
}

describe("classifyLeagueBoardPhase", () => {
  it("classifies keeper pre-draft and fresh boards", () => {
    expect(classifyLeagueBoardPhase(keeperPreDraftState())).toBe(
      "keeper_pre_draft",
    );
    expect(classifyLeagueBoardPhase(freshState())).toBe("fresh");
  });
});

describe("resolveAuctionCurveForLeague", () => {
  it("adaptive uses linear on fresh boards", () => {
    const sb = new Map([
      ["a", 9.4],
      ["b", 8.8],
      ["c", 7.8],
    ]);
    const preview = previewLinearSurplusAuction(["a", "b", "c"], sb, 3, 1);
    const res = resolveAuctionCurveForLeague({
      requestedModel: "adaptive_surplus_v1",
      state: freshState(),
      linearPreview: preview,
    });
    expect(res.internalMode).toBe("linear");
    expect(res.reason).toBe("fresh_board_linear");
  });

  it("adaptive tiers keeper-compressed boards", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const sb = new Map(ids.map((id, i) => [id, 63 - i * 0.05]));
    const preview = previewLinearSurplusAuction(ids, sb, 0.25, 1);
    expect(preview.top10Spread).toBeLessThan(1.5);
    const state = keeperPreDraftState();
    expect(isLinearCurveOverCompressedState(state, preview)).toBe(true);
    const res = resolveAuctionCurveForLeague({
      requestedModel: "adaptive_surplus_v1",
      state,
      linearPreview: preview,
    });
    expect(res.internalMode).toBe("tiered_keeper");
    expect(res.reason).toBe("keeper_compressed_linear_tiered");
  });
});

describe("applySurplusGuardrails", () => {
  it("caps keeper-compressed tiered board and conserves surplus", () => {
    const ids = Array.from({ length: 113 }, (_, i) => `k${i}`);
    const sb = new Map(ids.map((id, i) => [id, 63 - i * 0.05]));
    const surplusCash = 1309;
    const tiered = buildTieredSurplusDollars({
      surplusCash,
      draftablePlayerIds: ids,
      surplusBasisById: sb,
    });
    const state = keeperPreDraftState();
    const guarded = applySurplusGuardrails({
      dollarsByPlayerId: tiered.dollarsByPlayerId,
      surplusCash,
      minBid: 1,
      guardrails: computeSurplusGuardrailCaps(state, "keeper_pre_draft"),
      phase: "keeper_pre_draft",
      keeperCount: state.keeperCount,
    });
    let top = 0;
    let sum = 0;
    for (const d of guarded.dollarsByPlayerId.values()) {
      sum += d;
      if (d > top) top = d;
    }
    expect(top).toBeLessThanOrEqual(48);
    expect(sum).toBeCloseTo(surplusCash, 0);
  });
});
