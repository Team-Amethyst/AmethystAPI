import { describe, expect, it } from "vitest";
import type { ProposedCatalogUpdate } from "../src/lib/marketAdp/types";
import {
  aggregateRowsSkippedInvalid,
  assertMarketAdpApplyPermitted,
  assertPreviewSafeForMarketAdpApply,
  buildMarketAdpApplyPlanFromPreview,
  MARKET_ADP_APPLY_FIELD_KEYS,
  sanitizeMarketAdpMongoSet,
  isStrictlyNumericMlbPlayerId,
} from "../src/lib/marketAdp/applyMarketAdpFromPreview";

const baseSet = {
  market_adp: 12.5,
  market_adp_source: "NFBC",
  market_adp_updated_at: "2026-01-01T00:00:00.000Z",
  market_adp_min: 10,
  market_adp_max: 15,
  market_pick_count: 100,
};

describe("sanitizeMarketAdpMongoSet", () => {
  it("keeps only allowlisted market ADP fields", () => {
    const raw = {
      ...baseSet,
      market_adp_match_confidence: "exact_name_team_position",
      catalog_rank: 1,
      value: 99,
    };
    const s = sanitizeMarketAdpMongoSet(raw);
    expect(Object.keys(s).sort()).toEqual([...MARKET_ADP_APPLY_FIELD_KEYS].sort());
    expect(s).not.toHaveProperty("market_adp_match_confidence");
    expect(s).not.toHaveProperty("catalog_rank");
  });
});

describe("assertMarketAdpApplyPermitted", () => {
  it("allows dry-run without env confirm", () => {
    expect(() =>
      assertMarketAdpApplyPermitted({ apply: false, env: {} })
    ).not.toThrow();
  });

  it("refuses apply without MARKET_ADP_APPLY_CONFIRM=YES", () => {
    expect(() =>
      assertMarketAdpApplyPermitted({ apply: true, env: {} })
    ).toThrow(/MARKET_ADP_APPLY_CONFIRM/);
  });

  it("allows apply when env is confirmed", () => {
    expect(() =>
      assertMarketAdpApplyPermitted({ apply: true, env: { MARKET_ADP_APPLY_CONFIRM: "YES" } })
    ).not.toThrow();
  });
});

describe("buildMarketAdpApplyPlanFromPreview", () => {
  it("builds operations with $set containing only market ADP fields", () => {
    const proposed: ProposedCatalogUpdate[] = [
      {
        mlb_id: 123,
        player_id: "123",
        match_confidence: "mlb_id",
        set: {
          ...baseSet,
          market_adp_match_confidence: "mlb_id",
        },
      },
    ];
    const plan = buildMarketAdpApplyPlanFromPreview({ proposed_updates: proposed });
    expect(plan.stats.updates_to_apply).toBe(1);
    expect(plan.operations[0]?.$set).toEqual(baseSet);
    expect(plan.stats.proposals_with_non_market_fields_stripped).toBe(1);
  });

  it("skips ObjectId-style player_id rows", () => {
    const proposed: ProposedCatalogUpdate[] = [
      {
        mlb_id: 123,
        player_id: "507f1f77bcf86cd799439011",
        set: { ...baseSet },
      },
    ];
    const plan = buildMarketAdpApplyPlanFromPreview({ proposed_updates: proposed });
    expect(plan.stats.updates_to_apply).toBe(0);
    expect(plan.stats.skipped_invalid_player_id).toBe(1);
  });

  it("skips when mlb_id disagrees with numeric player_id", () => {
    const proposed: ProposedCatalogUpdate[] = [
      {
        mlb_id: 999,
        player_id: "123",
        set: { ...baseSet },
      },
    ];
    const plan = buildMarketAdpApplyPlanFromPreview({ proposed_updates: proposed });
    expect(plan.stats.skipped_mlb_id_player_id_mismatch).toBe(1);
    expect(plan.operations).toHaveLength(0);
  });

  it("counts ambiguous vendor rows from preview.matches", () => {
    const plan = buildMarketAdpApplyPlanFromPreview({
      proposed_updates: [],
      matches: [{ kind: "ambiguous" }, { kind: "matched" }, { kind: "ambiguous" }],
    });
    expect(plan.ambiguous_vendor_rows_in_preview).toBe(2);
  });

  it("refuses assertPreviewSafeForMarketAdpApply when ambiguous present", () => {
    const plan = buildMarketAdpApplyPlanFromPreview({
      proposed_updates: [
        {
          mlb_id: 1,
          player_id: "1",
          set: { ...baseSet },
        },
      ],
      matches: [{ kind: "ambiguous" }],
    });
    expect(() => assertPreviewSafeForMarketAdpApply(plan)).toThrow(/ambiguous/);
  });
});

describe("isStrictlyNumericMlbPlayerId", () => {
  it("rejects leading zero and non-numeric", () => {
    expect(isStrictlyNumericMlbPlayerId("0123")).toBe(false);
    expect(isStrictlyNumericMlbPlayerId("abc")).toBe(false);
  });
});

describe("aggregateRowsSkippedInvalid", () => {
  it("sums invalid-skip counters", () => {
    const plan = buildMarketAdpApplyPlanFromPreview({
      proposed_updates: [
        {
          mlb_id: 1,
          player_id: "507f1f77bcf86cd799439011",
          set: { ...baseSet },
        },
        {
          mlb_id: 2,
          player_id: "2",
          set: { market_adp_source: "NFBC" },
        },
      ],
    });
    expect(plan.stats.skipped_invalid_player_id).toBe(1);
    expect(plan.stats.skipped_missing_market_adp).toBe(1);
    expect(aggregateRowsSkippedInvalid(plan.stats)).toBe(2);
  });
});
