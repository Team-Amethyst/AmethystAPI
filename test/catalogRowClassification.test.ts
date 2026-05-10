import { describe, expect, it } from "vitest";
import {
  classifyCatalogDoc,
  isValuationEligibleCatalogRow,
} from "../src/lib/catalogRowClassification";
import type { LeanPlayer } from "../src/types/brain";

describe("catalogRowClassification", () => {
  it("treats positive mlbId as canonical MLB row", () => {
    expect(classifyCatalogDoc({ mlbId: 660271 })).toBe("canonical_mlb_player");
  });

  it("treats catalogKind custom as custom even without mlbId", () => {
    expect(classifyCatalogDoc({ catalogKind: "custom", name: "X" })).toBe("custom_player");
  });

  it("invalid when no mlbId and not custom", () => {
    expect(classifyCatalogDoc({ name: "Orphan" })).toBe("invalid_catalog_row");
  });

  it("valuation eligibility includes MLB and custom only", () => {
    const canon: LeanPlayer & { catalogKind?: "mlb" | "custom" } = {
      _id: "a",
      name: "A",
      team: "NYY",
      position: "C",
      mlbId: 1,
      catalog_rank: 1,
      catalog_tier: 1,
      value: 10,
    };
    const custom: LeanPlayer & { catalogKind?: "mlb" | "custom" } = {
      _id: "507f1f77bcf86cd799439011",
      name: "Custom",
      team: "FA",
      position: "P",
      catalogKind: "custom",
      catalog_rank: 99,
      catalog_tier: 9,
      value: 1,
    };
    const bad: LeanPlayer = {
      _id: "507f1f77bcf86cd799439012",
      name: "Bad",
      team: "FA",
      position: "P",
      catalog_rank: 99,
      catalog_tier: 9,
      value: 1,
    };
    expect(isValuationEligibleCatalogRow(canon)).toBe(true);
    expect(isValuationEligibleCatalogRow(custom)).toBe(true);
    expect(isValuationEligibleCatalogRow(bad)).toBe(false);
  });
});
