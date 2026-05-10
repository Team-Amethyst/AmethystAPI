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

  it("treats extended roto categories as supported", () => {
    expect(
      listUnsupportedScoringCategories([
        { name: "HLD", type: "pitching" },
        { name: "SV+HLD", type: "pitching" },
        { name: "SLG", type: "batting" },
        { name: "OPS", type: "batting" },
        { name: "TB", type: "batting" },
        { name: "K/9", type: "pitching" },
      ])
    ).toHaveLength(0);
  });

  it("builds human-readable warnings", () => {
    const u = listUnsupportedScoringCategories([
      { name: "ZZZ_UNSUPPORTED_FAKE_STAT", type: "batting" },
    ]);
    const w = scoringCategorySupportWarnings(u);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("ZZZ_UNSUPPORTED_FAKE_STAT");
    expect(w[0]).toContain("not modeled");
  });
});
