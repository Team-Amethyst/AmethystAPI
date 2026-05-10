import { describe, expect, it } from "vitest";
import { calculateInflation } from "../src/services/inflationEngine";
import type { DraftedPlayer, LeanPlayer, RosterSlot } from "../src/types/brain";

const roster: RosterSlot[] = [{ position: "OF", count: 2 }];

function mkLean(
  id: string,
  partial: Partial<LeanPlayer> & Pick<LeanPlayer, "value">
): LeanPlayer {
  return {
    _id: id,
    name: `P${id}`,
    team: "NYY",
    position: "OF",
    catalog_rank: Number(id),
    catalog_tier: 2,
    ...partial,
  };
}

describe("rank/tier semantics on valuation rows", () => {
  it("catalog_rank echoes internal sort order, not market ADP labeling", () => {
    const players = [
      mkLean("1", { value: 40, catalog_rank: 3 }),
      mkLean("2", { value: 41, catalog_rank: 1 }),
    ];
    const res = calculateInflation(players, [], 260, 2, roster, "Mixed", {
      inflationModel: "global_v1",
    });
    expect(res.valuations).toHaveLength(2);
    const r1 = res.valuations.find((v) => v.player_id === "1")!;
    expect(r1.catalog_rank).toBe(3);
    expect(r1).not.toHaveProperty("market_adp");
  });

  it("auction_rank sorts by auction_value within the response", () => {
    const players = [
      mkLean("1", { value: 10 }),
      mkLean("2", { value: 20 }),
      mkLean("3", { value: 15 }),
    ];
    const res = calculateInflation(players, [], 260, 2, roster, "Mixed", {
      inflationModel: "global_v1",
    });
    const byAuction = [...res.valuations].sort(
      (a, b) => b.auction_value - a.auction_value
    );
    expect(byAuction[0]!.auction_rank).toBe(1);
    expect(byAuction[1]!.auction_rank).toBe(2);
    expect(byAuction[2]!.auction_rank).toBe(3);
  });

  it("baseline_rank sorts by baseline_value within the response", () => {
    const players = [
      mkLean("1", { value: 10 }),
      mkLean("2", { value: 25 }),
      mkLean("3", { value: 18 }),
    ];
    const res = calculateInflation(players, [], 260, 2, roster, "Mixed", {
      inflationModel: "global_v1",
    });
    const byBase = [...res.valuations].sort(
      (a, b) => b.baseline_value - a.baseline_value
    );
    expect(byBase.map((r) => r.player_id)).toEqual(["2", "3", "1"]);
    expect(byBase[0]!.baseline_rank).toBe(1);
    expect(byBase[1]!.baseline_rank).toBe(2);
    expect(byBase[2]!.baseline_rank).toBe(3);
  });

  it("auction_tier is stable for the same valuation response (deterministic fixture)", () => {
    const players = Array.from({ length: 10 }, (_, i) =>
      mkLean(String(i + 1), { value: 50 - i })
    );
    const res = calculateInflation(players, [], 260, 2, roster, "Mixed", {
      inflationModel: "global_v1",
      deterministic: true,
      seed: 42,
    });
    const again = calculateInflation(players, [], 260, 2, roster, "Mixed", {
      inflationModel: "global_v1",
      deterministic: true,
      seed: 42,
    });
    expect(res.valuations.map((r) => `${r.player_id}:${r.auction_tier}`)).toEqual(
      again.valuations.map((r) => `${r.player_id}:${r.auction_tier}`)
    );
  });

  it("market_adp is absent when no external source exists", () => {
    const players = [mkLean("1", { value: 30 })];
    const res = calculateInflation(players, [], 260, 2, roster, "Mixed", {
      inflationModel: "global_v1",
    });
    expect(res.valuations[0]).not.toHaveProperty("market_adp");
  });

  it("echoes ingested market_adp metadata from catalog lean rows", () => {
    const players = [
      mkLean("1", {
        value: 30,
        market_adp: 18.5,
        market_adp_source: "fixture",
        market_adp_updated_at: "2026-05-01T00:00:00.000Z",
      }),
    ];
    const res = calculateInflation(players, [], 260, 2, roster, "Mixed", {
      inflationModel: "global_v1",
    });
    const row = res.valuations[0]!;
    expect(row.market_adp).toBe(18.5);
    expect(row.market_adp_source).toBe("fixture");
    expect(row.market_adp_updated_at).toBe("2026-05-01T00:00:00.000Z");
    expect(row.catalog_rank).toBe(1);
    expect(row.catalog_rank).not.toBe(row.market_adp);
  });

  it("subset player_ids filter keeps ranks relative to returned valuations[] only", () => {
    const players = [
      mkLean("1", { value: 50 }),
      mkLean("2", { value: 40 }),
      mkLean("3", { value: 30 }),
    ];
    const drafted: DraftedPlayer[] = [];
    const res = calculateInflation(players, drafted, 260, 2, roster, "Mixed", {
      inflationModel: "global_v1",
      playerIdsFilter: ["2", "3"],
    });
    expect(res.valuations).toHaveLength(2);
    const sorted = [...res.valuations].sort(
      (a, b) => b.auction_value - a.auction_value
    );
    expect(sorted[0]!.auction_rank).toBe(1);
    expect(sorted[1]!.auction_rank).toBe(2);
  });
});
