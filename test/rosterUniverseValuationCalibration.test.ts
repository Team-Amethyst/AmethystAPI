import { describe, expect, it } from "vitest";
import {
  buildDraftroomStandardValuationInput,
  buildSyntheticCalibrationDraftroomPool,
} from "../src/lib/calibrationDraftroomFixture";
import {
  classifyAuctionFloorCollapse,
  playerIdLooksLikeMongoObjectId,
  playerSyncDocsToValuationLeanPlayers,
  summarizeValuationResponse,
  top25AuctionPlayerOverlapFromValuations,
} from "../src/lib/rosterUniverseValuationCalibration";
import type { ValuedPlayer } from "../src/types/valuation";
import type { PlayerSyncDoc } from "../src/lib/mlbPlayerSyncFromSplits";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";

describe("rosterUniverseValuationCalibration", () => {
  it("playerSyncDocsToValuationLeanPlayers skips non-valuation tiers", () => {
    const docs: PlayerSyncDoc[] = [
      {
        mlbId: 1,
        catalogKind: "mlb",
        name: "A",
        team: "NYY",
        position: "P",
        age: 28,
        value: 10,
        catalog_tier: 1,
        stats: {},
        projection: { pitching: { era: "3.00", innings: "100" } },
        outlook: "",
        catalogValuationTier: "valuation_eligible",
        catalog_rank: 1,
      },
      {
        mlbId: 2,
        catalogKind: "mlb",
        name: "B",
        team: "FA",
        position: "P",
        age: 25,
        value: 0,
        catalog_tier: 0,
        stats: {},
        projection: {},
        outlook: "",
        catalogValuationTier: "market_only",
        catalog_rank: 9999,
      },
    ];
    const lean = playerSyncDocsToValuationLeanPlayers(docs);
    expect(lean).toHaveLength(1);
    expect(lean[0]?.mlbId).toBe(1);
  });

  it("summarizeValuationResponse returns counts for synthetic pool", () => {
    const pool = buildSyntheticCalibrationDraftroomPool();
    const input = buildDraftroomStandardValuationInput({ deterministic: true, seed: 1 });
    const wf = executeValuationWorkflow(pool, input);
    expect(wf.ok).toBe(true);
    if (!wf.ok) return;
    const snap = summarizeValuationResponse("test", pool, input, wf);
    expect(snap.ok).toBe(true);
    expect(snap.eligible_pool_size).toBeGreaterThan(100);
    expect(snap.top25_auction_value.length).toBe(25);
  });

  it("playerIdLooksLikeMongoObjectId detects 24-hex ids", () => {
    expect(playerIdLooksLikeMongoObjectId("507f1f77bcf86cd799439011")).toBe(true);
    expect(playerIdLooksLikeMongoObjectId("666176")).toBe(false);
    expect(playerIdLooksLikeMongoObjectId("ru_v1_123")).toBe(false);
  });

  it("classifyAuctionFloorCollapse flags replacement key changes", () => {
    const r = classifyAuctionFloorCollapse({
      oldReplacementKey: "OF1",
      newReplacementKey: "OF2",
      mongoBaseline: 10,
      rosterBaseline: 9,
    });
    expect(r.classification).toBe("position_replacement_artifact");
  });

  it("top25AuctionPlayerOverlapFromValuations counts shared top names", () => {
    const mk = (id: string, av: number): ValuedPlayer =>
      ({
        player_id: id,
        name: id,
        position: "OF",
        team: "NYY",
        catalog_rank: 1,
        catalog_tier: 1,
        baseline_rank: 1,
        auction_rank: 1,
        baseline_tier: 1,
        auction_tier: 1,
        baseline_value: av,
        auction_value: av,
        adjusted_value: av,
        indicator: "neutral",
        inflation_factor: 1,
      }) as ValuedPlayer;
    const mongo = ["a", "b", "c", "d", "e"].map((id, i) => mk(id, 100 - i));
    const roster = [
      mk("a", 100),
      mk("b", 99),
      mk("c", 98),
      mk("x", 97),
      mk("y", 96),
    ];
    const o = top25AuctionPlayerOverlapFromValuations(mongo, roster);
    expect(o.overlap_count).toBe(3);
    expect(o.mongo_only_player_ids.sort()).toEqual(["d", "e"]);
    expect(o.roster_only_player_ids.sort()).toEqual(["x", "y"]);
  });
});
