import { describe, expect, it } from "vitest";
import { resolveSurplusSmoothingConfig } from "../src/services/auctionSurplusSmoothing";

describe("Stage 3 surplus smoothing", () => {
  it("preserves more linear spread in late_draft when many slots remain open", () => {
    const tight = resolveSurplusSmoothingConfig("tiered_soft", "late_draft", 40);
    const open = resolveSurplusSmoothingConfig("tiered_soft", "late_draft", 90);
    expect(open?.tieredFraction).toBeGreaterThan(tight?.tieredFraction ?? 0);
    expect(open?.tieredFraction).toBeGreaterThanOrEqual(0.8);
  });
});
