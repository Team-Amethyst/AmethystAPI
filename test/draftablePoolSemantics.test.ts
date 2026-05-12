import { describe, expect, it } from "vitest";
import {
  TOOLTIP_OUTSIDE_DRAFTABLE_MIN_BID,
  isNearMinimumAuctionBid,
  isPlayerInDraftablePool,
  normalizeDraftablePoolMeta,
  shouldShowOutsideDraftableMinBidTooltip,
} from "../src/lib/draftablePoolSemantics";

describe("draftablePoolSemantics", () => {
  it("recognizes a draftable player when metadata is resolved", () => {
    const meta = normalizeDraftablePoolMeta({
      draftable_pool_size: 2,
      draftable_player_ids: ["a", "b"],
    });
    expect(meta.kind).toBe("resolved");
    if (meta.kind !== "resolved") return;
    expect(isPlayerInDraftablePool(meta, "a")).toBe(true);
    expect(isPlayerInDraftablePool(meta, "b")).toBe(true);
  });

  it("recognizes an outside-draftable player", () => {
    const meta = normalizeDraftablePoolMeta({
      draftable_pool_size: 1,
      draftable_player_ids: ["only-me"],
    });
    expect(meta.kind).toBe("resolved");
    if (meta.kind !== "resolved") return;
    expect(isPlayerInDraftablePool(meta, "other")).toBe(false);
  });

  it("shows tooltip for $1 outside-draftable row", () => {
    const meta = normalizeDraftablePoolMeta({
      draftable_pool_size: 1,
      draftable_player_ids: ["star"],
    });
    expect(meta.kind).toBe("resolved");
    expect(
      shouldShowOutsideDraftableMinBidTooltip({
        meta,
        playerId: "bench",
        auctionValue: 1,
      })
    ).toBe(true);
    expect(TOOLTIP_OUTSIDE_DRAFTABLE_MIN_BID.length).toBeGreaterThan(20);
  });

  it("does not show tooltip for draftable player at $1", () => {
    const meta = normalizeDraftablePoolMeta({
      draftable_pool_size: 1,
      draftable_player_ids: ["star"],
    });
    expect(meta.kind).toBe("resolved");
    expect(
      shouldShowOutsideDraftableMinBidTooltip({
        meta,
        playerId: "star",
        auctionValue: 1,
      })
    ).toBe(false);
  });

  it("falls back safely when draftable_player_ids is missing", () => {
    const meta = normalizeDraftablePoolMeta({
      draftable_pool_size: 252,
    });
    expect(meta.kind).toBe("unknown");
    expect(isPlayerInDraftablePool(meta, "any")).toBe(null);
    expect(
      shouldShowOutsideDraftableMinBidTooltip({
        meta,
        playerId: "any",
        auctionValue: 1,
      })
    ).toBe(false);
  });

  it("falls back safely on length mismatch", () => {
    const meta = normalizeDraftablePoolMeta({
      draftable_pool_size: 2,
      draftable_player_ids: ["only-one"],
    });
    expect(meta.kind).toBe("unknown");
    expect(isPlayerInDraftablePool(meta, "only-one")).toBe(null);
  });

  it("isNearMinimumAuctionBid matches calibration band", () => {
    expect(isNearMinimumAuctionBid(1)).toBe(true);
    expect(isNearMinimumAuctionBid(1.05)).toBe(true);
    expect(isNearMinimumAuctionBid(1.06)).toBe(false);
  });
});
