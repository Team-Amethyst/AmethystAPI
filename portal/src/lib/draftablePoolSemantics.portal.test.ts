import { describe, expect, it } from "vitest";
import { normalizeDraftablePoolMeta } from "@engine/lib/draftablePoolSemantics";

describe("portal → @engine draftablePoolSemantics", () => {
  it("resolves the shared module via Vite/Vitest alias", () => {
    const m = normalizeDraftablePoolMeta({
      draftable_pool_size: 1,
      draftable_player_ids: ["660271"],
    });
    expect(m.kind).toBe("resolved");
  });
});
