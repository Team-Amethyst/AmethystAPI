import { describe, expect, it } from "vitest";
import {
  categoryRawValue,
  categoryWeight,
  pointsCategoryRaw,
  getProjectionSection,
} from "../src/services/baselineProjectionStats";
import type { LeanPlayer } from "../src/types/brain";
import {
  listUnsupportedScoringCategories,
  normalizeScoringCategoryName,
} from "../src/lib/scoringCategorySupport";

describe("baselineProjectionStats extended scoring categories", () => {
  const batting = {
    avg: ".280",
    obp: ".350",
    slg: ".450",
    ops: ".800",
    totalBases: 240,
    atBats: 550,
    plateAppearances: 600,
  };
  const pitching = {
    wins: 12,
    saves: 8,
    holds: 14,
    strikeouts: 180,
    innings: "165",
    inningsPitched: 165,
    era: "3.20",
    whip: "1.10",
    qualityStarts: 20,
  };

  it("categoryRawValue SLG × AB", () => {
    expect(categoryRawValue(batting, "SLG")).toBeCloseTo(0.45 * 550, 5);
  });

  it("categoryRawValue OPS × PA", () => {
    expect(categoryRawValue(batting, "OPS")).toBeCloseTo(0.8 * 600, 5);
  });

  it("categoryRawValue TB count", () => {
    expect(categoryRawValue(batting, "TB")).toBe(240);
  });

  it("categoryRawValue HLD count", () => {
    expect(categoryRawValue(pitching, "HLD")).toBe(14);
  });

  it("categoryRawValue SV+HLD sum", () => {
    expect(categoryRawValue(pitching, "SV+HLD")).toBe(8 + 14);
  });

  it("categoryRawValue K/9 from K and IP", () => {
    const k9 = (9 * 180) / 165;
    expect(categoryRawValue(pitching, "K/9")).toBeCloseTo(k9, 10);
  });

  it("categoryRawValue QS count", () => {
    expect(categoryRawValue(pitching, "QS")).toBe(20);
  });

  it("categoryWeight keeps ERA/WHIP below AVG-class batting rates (rate-only roto inputs)", () => {
    expect(categoryWeight("ERA")).toBe(11);
    expect(categoryWeight("WHIP")).toBe(11);
    expect(categoryWeight("AVG")).toBe(14);
  });

  it("categoryRawValue ERA and WHIP are pitcher rates only (not multiplied by IP)", () => {
    expect(categoryRawValue(pitching, "ERA")).toBeCloseTo(3.2, 5);
    expect(categoryRawValue(pitching, "WHIP")).toBeCloseTo(1.1, 5);
    const hiIpSameRate = { ...pitching, innings: "210", era: "3.20", whip: "1.10" };
    expect(categoryRawValue(hiIpSameRate, "ERA")).toBeCloseTo(3.2, 5);
    expect(categoryRawValue(hiIpSameRate, "WHIP")).toBeCloseTo(1.1, 5);
  });

  it("pointsCategoryRaw parity for rates and counts", () => {
    expect(pointsCategoryRaw(batting, "SLG")).toBeCloseTo(0.45, 5);
    expect(pointsCategoryRaw(batting, "OPS")).toBeCloseTo(0.8, 5);
    expect(pointsCategoryRaw(batting, "TB")).toBe(240);
    expect(pointsCategoryRaw(pitching, "HLD")).toBe(14);
    expect(pointsCategoryRaw(pitching, "SV+HLD")).toBe(22);
    expect(pointsCategoryRaw(pitching, "K/9")).toBeCloseTo((9 * 180) / 165, 10);
    expect(pointsCategoryRaw(pitching, "QS")).toBe(20);
  });

  it("normalizeScoringCategoryName aliases", () => {
    expect(normalizeScoringCategoryName("k9")).toBe("K/9");
    expect(normalizeScoringCategoryName("K/9")).toBe("K/9");
    expect(normalizeScoringCategoryName("svhld")).toBe("SV+HLD");
    expect(normalizeScoringCategoryName("holds")).toBe("HLD");
  });

  it("listUnsupportedScoringCategories accepts new categories and aliases", () => {
    expect(
      listUnsupportedScoringCategories([
        { name: "SLG", type: "batting" },
        { name: "OPS", type: "batting" },
        { name: "TB", type: "batting" },
        { name: "HLD", type: "pitching" },
        { name: "SV+HLD", type: "pitching" },
        { name: "K9", type: "pitching" },
      ])
    ).toHaveLength(0);
  });

  it("getProjectionSection reads batting/pitching from lean player", () => {
    const p = {
      _id: "x",
      mlbId: 1,
      name: "T",
      team: "A",
      position: "SP",
      catalog_rank: 1,
      catalog_tier: 1,
      value: 10,
      projection: { batting, pitching },
    } satisfies LeanPlayer;
    expect(categoryRawValue(getProjectionSection(p, "pitching"), "HLD")).toBe(14);
  });
});
