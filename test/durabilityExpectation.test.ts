import { describe, expect, it } from "vitest";
import type { LeanPlayer } from "../src/types/brain";
import { classifyDurabilityExpectation } from "../src/lib/durabilityExpectation";

function P(p: Partial<LeanPlayer> & Pick<LeanPlayer, "mlbId" | "name" | "position">): LeanPlayer {
  return {
    _id: String(p.mlbId),
    catalog_rank: 999,
    catalog_tier: 3,
    team: "TEX",
    ...p,
  } as LeanPlayer;
}

describe("classifyDurabilityExpectation", () => {
  it("classifies Yordan Alvarez as recovery_upside", () => {
    const r = classifyDurabilityExpectation(
      P({
        mlbId: 670541,
        name: "Yordan Alvarez",
        position: "DH",
        age: 28,
        catalog_tier: 4,
        catalog_rank: 320,
        depthChartPosition: 2,
        market_adp: 37.15,
        injurySeverity: undefined,
        projection: { batting: { plateAppearances: 389 } },
      })
    );
    expect(r.durability_expectation).toBe("recovery_upside");
    expect(r.durability_expectation_reasons).toContain("low projected PA");
  });

  it("classifies Ronald Acuña Jr. as recovery_upside when healthy", () => {
    const r = classifyDurabilityExpectation(
      P({
        mlbId: 660670,
        name: "Ronald Acuña Jr.",
        position: "RF",
        age: 28,
        catalog_tier: 1,
        catalog_rank: 72,
        depthChartPosition: 2,
        market_adp: 6.73,
        injurySeverity: 0,
        projection: { batting: { plateAppearances: 420 } },
      })
    );
    expect(r.durability_expectation).toBe("recovery_upside");
  });

  it("does not assign recovery_upside when injurySeverity > 0", () => {
    const r = classifyDurabilityExpectation(
      P({
        mlbId: 660670,
        name: "Ronald Acuña Jr.",
        position: "RF",
        age: 28,
        catalog_tier: 1,
        catalog_rank: 72,
        depthChartPosition: 2,
        market_adp: 6.73,
        injurySeverity: 2,
        projection: { batting: { plateAppearances: 420 } },
      })
    );
    expect(r.durability_expectation).toBe("limited_role_expected");
    expect(r.durability_expectation_reasons).toContain("active injury severity");
  });

  it("classifies Byron Buxton as limited_role_expected (late ADP + low PA band)", () => {
    const r = classifyDurabilityExpectation(
      P({
        mlbId: 621439,
        name: "Byron Buxton",
        position: "CF",
        age: 32,
        catalog_tier: 1,
        catalog_rank: 33,
        depthChartPosition: 1,
        market_adp: 73.61,
        injurySeverity: undefined,
        projection: { batting: { plateAppearances: 484 } },
      })
    );
    expect(r.durability_expectation).toBe("limited_role_expected");
  });

  it("classifies Bryce Harper as full_role_expected", () => {
    const r = classifyDurabilityExpectation(
      P({
        mlbId: 547180,
        name: "Bryce Harper",
        position: "1B",
        age: 32,
        catalog_tier: 1,
        catalog_rank: 100,
        depthChartPosition: 1,
        market_adp: 47.55,
        injurySeverity: undefined,
        projection: { batting: { plateAppearances: 589 } },
      })
    );
    expect(r.durability_expectation).toBe("full_role_expected");
    expect(r.durability_expectation_reasons).toContain("full workload projection");
  });

  it("classifies Nick Kurtz and Junior Caminero as prospect_uncertain", () => {
    const kurtz = classifyDurabilityExpectation(
      P({
        mlbId: 701762,
        name: "Nick Kurtz",
        position: "1B",
        age: 23,
        catalog_tier: 1,
        catalog_rank: 56,
        depthChartPosition: 1,
        market_adp: 19.15,
        projection: { batting: { plateAppearances: 489 } },
      })
    );
    expect(kurtz.durability_expectation).toBe("prospect_uncertain");

    const cam = classifyDurabilityExpectation(
      P({
        mlbId: 691406,
        name: "Junior Caminero",
        position: "3B",
        age: 22,
        catalog_tier: 1,
        catalog_rank: 36,
        depthChartPosition: 1,
        market_adp: 15.5,
        projection: { batting: { plateAppearances: 475 } },
      })
    );
    expect(cam.durability_expectation).toBe("prospect_uncertain");
  });

  it("classifies Roman Anthony as prospect_uncertain (weak catalog rank)", () => {
    const r = classifyDurabilityExpectation(
      P({
        mlbId: 701350,
        name: "Roman Anthony",
        position: "RF",
        age: 22,
        catalog_tier: 5,
        catalog_rank: 870,
        depthChartPosition: 2,
        market_adp: 54.17,
        projection: { batting: { plateAppearances: 303 } },
      })
    );
    expect(r.durability_expectation).toBe("prospect_uncertain");
  });

  it("classifies platoon_or_part_time when depthChartPosition 2 and market_adp >= 42", () => {
    const r = classifyDurabilityExpectation(
      P({
        mlbId: 999001,
        name: "Platoon Test",
        position: "OF",
        age: 28,
        catalog_tier: 2,
        catalog_rank: 80,
        depthChartPosition: 2,
        market_adp: 50,
        projection: { batting: { plateAppearances: 400 } },
      })
    );
    expect(r.durability_expectation).toBe("platoon_or_part_time");
  });
});
