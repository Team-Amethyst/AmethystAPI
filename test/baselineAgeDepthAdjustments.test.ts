import { describe, expect, it } from "vitest";
import {
  AGE_DEPTH_TUNING,
  applyAgeDepthAdjustment,
  depthChartMultiplier,
  resolveDepthChartPosition,
} from "../src/services/baselineAgeDepthAdjustments";
import type { LeanPlayer } from "../src/types/brain";

function mkPlayer(overrides: Partial<LeanPlayer> = {}): LeanPlayer {
  return {
    _id: "p1",
    mlbId: 1,
    name: "Player",
    team: "NYY",
    position: "OF",
    adp: 100,
    tier: 2,
    value: 20,
    ...overrides,
  };
}

describe("baselineAgeDepthAdjustments", () => {
  it("resolves explicit depthChartPosition first", () => {
    const p = mkPlayer({ depthChartPosition: 1, tier: 4 });
    expect(resolveDepthChartPosition(p)).toBe(1);
  });

  it("falls back to projection depth fields when direct field is absent", () => {
    const p = mkPlayer({
      projection: { depth_chart_position: 3 } as Record<string, unknown>,
      tier: 1,
    });
    expect(resolveDepthChartPosition(p)).toBe(3);
  });

  it("falls back to tier proxy when depth data is absent", () => {
    expect(resolveDepthChartPosition(mkPlayer({ tier: 1 }))).toBe(1);
    expect(resolveDepthChartPosition(mkPlayer({ tier: 3 }))).toBe(2);
    expect(resolveDepthChartPosition(mkPlayer({ tier: 6 }))).toBe(3);
  });

  it("applies stronger multiplier to starters than reserves", () => {
    expect(depthChartMultiplier(1)).toBeGreaterThan(depthChartMultiplier(3));
    expect(depthChartMultiplier(4)).toBe(AGE_DEPTH_TUNING.depth.reserve_mult);
  });

  it("combines age + depth into bounded baseline adjustment", () => {
    const primeStarter = mkPlayer({ age: 27, depthChartPosition: 1 });
    const oldReserve = mkPlayer({ age: 39, depthChartPosition: 4 });

    const hi = applyAgeDepthAdjustment({
      player: primeStarter,
      baselineValue: 20,
      isPitcher: false,
    });
    const lo = applyAgeDepthAdjustment({
      player: oldReserve,
      baselineValue: 20,
      isPitcher: false,
    });

    expect(hi.adjustedValue).toBeGreaterThan(lo.adjustedValue);
    expect(hi.ageDepthComponent).toBeGreaterThan(0);
    expect(lo.ageDepthComponent).toBeLessThan(0);
  });
});
