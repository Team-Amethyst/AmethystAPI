import { describe, expect, it } from "vitest";
import {
  listUnsupportedScoringCategories,
  normalizeScoringCategoryName,
  scoringCategorySupportWarnings,
} from "../src/lib/scoringCategorySupport";

describe("scoringCategorySupport", () => {
  it("treats SO as an alias for K (pitching)", () => {
    expect(normalizeScoringCategoryName("so")).toBe("K");
    expect(
      listUnsupportedScoringCategories([{ name: "SO", type: "pitching" }])
    ).toHaveLength(0);
  });

  it("flags HLD, SV+HLD, SLG, OPS, TB, K/9 as unsupported", () => {
    const u = listUnsupportedScoringCategories([
      { name: "HLD", type: "pitching" },
      { name: "SV+HLD", type: "pitching" },
      { name: "SLG", type: "batting" },
      { name: "OPS", type: "batting" },
      { name: "TB", type: "batting" },
      { name: "K/9", type: "pitching" },
    ]);
    expect(u.map((x) => x.normalized).sort()).toEqual([
      "HLD",
      "K/9",
      "OPS",
      "SLG",
      "SV+HLD",
      "TB",
    ]);
  });

  it("builds human-readable warnings", () => {
    const u = listUnsupportedScoringCategories([{ name: "TB", type: "batting" }]);
    const w = scoringCategorySupportWarnings(u);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("TB");
    expect(w[0]).toContain("not modeled");
  });
});
