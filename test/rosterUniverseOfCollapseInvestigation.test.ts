import { describe, expect, it } from "vitest";
import {
  diagnoseOfStyleCollapse,
  leanCarriesOutfieldToken,
} from "../src/lib/rosterUniverseOfCollapseInvestigation";
import type { LeanPlayer } from "../src/types/brain";

describe("rosterUniverseOfCollapseInvestigation", () => {
  it("diagnoseOfStyleCollapse flags replacement key drift", () => {
    const d = diagnoseOfStyleCollapse({
      old_replacement_key: "2B",
      new_replacement_key: "SS",
      old_replacement_value: 40,
      new_replacement_value: 45,
      old_surplus_basis: 8,
      new_surplus_basis: 0,
      old_baseline_value: 48,
      new_baseline_value: 44,
      old_auction_value: 12,
      new_auction_value: 1,
    });
    expect(d.verdict).toBe("of_replacement_level_artifact");
  });

  it("leanCarriesOutfieldToken reads positions array", () => {
    const p = {
      position: "DH",
      positions: ["DH", "OF"],
    } as LeanPlayer;
    expect(leanCarriesOutfieldToken(p)).toBe(true);
  });

  it("diagnoseOfStyleCollapse flags OF replacement bar rise with surplus wipe", () => {
    const d = diagnoseOfStyleCollapse({
      old_replacement_key: "OF",
      new_replacement_key: "OF",
      old_replacement_value: 31.79,
      new_replacement_value: 43.33,
      old_surplus_basis: 24,
      new_surplus_basis: 0,
      old_baseline_value: 56,
      new_baseline_value: 35,
      old_auction_value: 31,
      new_auction_value: 1,
    });
    expect(d.verdict).toBe("of_replacement_level_artifact");
  });
});
