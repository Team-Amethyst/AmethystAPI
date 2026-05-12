import { describe, expect, it } from "vitest";
import {
  buildDraftroomStandardValuationInput,
  buildSyntheticCalibrationDraftroomPool,
} from "../src/lib/calibrationDraftroomFixture";
import { sumAuctionValueForDraftablePool } from "../src/lib/rosterUniverseValuationCalibration";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";

function sumTopNByAuctionValue(
  rows: { player_id: string; auction_value: number }[],
  n: number
): number {
  const sorted = [...rows].sort((a, b) => b.auction_value - a.auction_value);
  return sorted.slice(0, Math.max(0, n)).reduce((s, r) => s + r.auction_value, 0);
}

describe("draftable pool auction $ audit (replacement_slots_v2)", () => {
  it("sums auction_value over draftable_player_ids match top-dps slice for synthetic 10/12/15 teams", () => {
    const pool = buildSyntheticCalibrationDraftroomPool();
    for (const num_teams of [10, 12, 15]) {
      const input = buildDraftroomStandardValuationInput({
        deterministic: true,
        seed: 42,
        num_teams,
      });
      const wf = executeValuationWorkflow(pool, input);
      expect(wf.ok).toBe(true);
      if (!wf.ok) return;
      const rows = wf.response.valuations;
      const dps = wf.response.draftable_pool_size ?? 0;
      const ids = wf.response.draftable_player_ids ?? [];
      expect(ids.length).toBe(dps);
      const { sum, mode } = sumAuctionValueForDraftablePool(rows, wf.response);
      expect(mode).toBe("draftable_player_ids");
      const topSlice = dps > 0 ? sumTopNByAuctionValue(rows, dps) : 0;
      expect(Math.abs(sum - topSlice)).toBeLessThan(1e-2);
    }
  });
});
