import { describe, expect, it } from "vitest";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import type { LeanPlayer } from "../src/types/brain";

function p(team: string, mlbId: number): LeanPlayer {
  return {
    _id: String(mlbId),
    mlbId,
    name: `p${mlbId}`,
    team,
    position: "OF",
    catalog_rank: 10,
    catalog_tier: 2,
    value: 5,
  };
}

describe("filterValuationUniverse", () => {
  it("applies league_scope before eligible_player_ids (AL scope drops NL id before allow-list)", () => {
    const pool = [p("NYY", 1), p("ATL", 2), p("BOS", 3)];
    const out = filterValuationUniverse(pool, {
      leagueScope: "AL",
      eligiblePlayerIds: ["1", "2", "3"],
    });
    expect(out.map((x) => x.mlbId)).toEqual([1, 3]);
  });

  it("applies excluded_player_ids after league scope", () => {
    const pool = [p("NYY", 1), p("BOS", 2)];
    const out = filterValuationUniverse(pool, {
      leagueScope: "AL",
      excludedPlayerIds: ["1"],
    });
    expect(out.map((x) => x.mlbId)).toEqual([2]);
  });
});
