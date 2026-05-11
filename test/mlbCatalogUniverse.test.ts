import { describe, expect, it, vi } from "vitest";
import { fetchAllSeasonSplitsPaginated } from "../src/lib/mlbCatalogUniverse/paginatedSeasonSplits";
import { collectRosterPersonIds } from "../src/lib/mlbCatalogUniverse/rosterCandidates";
import { extractNfbcMlbIdsFromMarketPreview } from "../src/lib/mlbCatalogUniverse/nfbcCandidateIds";
import { aggregatePositiveSplits } from "../src/lib/mlbPlayerSyncFromSplits";
import type { MlbStatSplit } from "../src/lib/mlbPlayerSyncFromSplits";
import { isValuationEligibleCatalogRow } from "../src/lib/catalogRowClassification";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import type { LeanPlayer } from "../src/types/brain";

function pitSplit(id: number, ip: string): MlbStatSplit {
  return {
    player: { id, fullName: `P${id}` },
    team: { id: 1, abbreviation: "SEA" },
    position: { abbreviation: "P" },
    stat: {
      gamesStarted: 22,
      inningsPitched: ip,
      wins: 10,
      saves: 0,
      strikeOuts: 150,
      era: "3.50",
      whip: "1.10",
    },
  };
}

/** George Kirby–shaped season line: clears `calcPitcherValue` volume gates. */
const kirbyLike = pitSplit(669923, "126.0");

describe("mlbCatalogUniverse", () => {
  it("paginated season splits fetch walks offset until exhausted", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (!url.includes("offset=")) {
        return {
          stats: [
            {
              totalSplits: 3,
              splits: [
                { player: { id: 1, fullName: "A" }, stat: { atBats: 500, homeRuns: 1 } },
                { player: { id: 2, fullName: "B" }, stat: { atBats: 400, homeRuns: 2 } },
              ],
            },
          ],
        };
      }
      return {
        stats: [
          {
            totalSplits: 3,
            splits: [{ player: { id: 3, fullName: "C" }, stat: { atBats: 450, homeRuns: 3 } }],
          },
        ],
      };
    });
    const splits = await fetchAllSeasonSplitsPaginated({
      mlbApiBase: "https://statsapi.mlb.com/api/v1",
      season: 2025,
      group: "hitting",
      pageSize: 2,
      fetchJson,
    });
    expect(splits).toHaveLength(3);
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("capped global pitching page can omit Kirby while a full list includes him for valuation aggregation", () => {
    const capped: MlbStatSplit[] = [];
    for (let i = 0; i < 300; i++) {
      capped.push(pitSplit(10_000 + i, "50.0"));
    }
    const cappedAgg = aggregatePositiveSplits([], capped);
    expect(cappedAgg.has(669923)).toBe(false);

    const full = [...capped, kirbyLike];
    const fullAgg = aggregatePositiveSplits([], full);
    expect(fullAgg.has(669923)).toBe(true);
  });

  it("collectRosterPersonIds dedupes across roster types", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/roster")) {
        return {
          roster: {
            roster: [{ person: { id: 669923 } }, { person: { id: 669923 } }],
          },
        };
      }
      return {};
    });
    const ids = await collectRosterPersonIds({
      mlbApiBase: "https://statsapi.mlb.com/api/v1",
      teamIds: [136],
      rosterTypes: ["40Man", "active"],
      fetchJson,
    });
    expect(ids.has(669923)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("extractNfbcMlbIdsFromMarketPreview reads vendor and catalog ids", () => {
    const s = extractNfbcMlbIdsFromMarketPreview({
      matches: [
        { kind: "matched", catalog_player: { mlbId: 660271 }, vendor: { mlb_id: 999 } },
        { kind: "unmatched_vendor", vendor: { mlb_id: 669923 } },
      ],
    });
    expect(s.has(660271)).toBe(true);
    expect(s.has(999)).toBe(true);
    expect(s.has(669923)).toBe(true);
  });

  it("isValuationEligibleCatalogRow excludes market_only and roster_context tiers", () => {
    const marketOnly: LeanPlayer = {
      _id: "x",
      name: "X",
      team: "FA",
      position: "P",
      mlbId: 1,
      catalog_rank: 9999,
      catalog_tier: 0,
      value: 0,
      catalogValuationTier: "market_only",
    };
    const rosterCtx: LeanPlayer = {
      _id: "y",
      name: "Y",
      team: "FA",
      position: "P",
      mlbId: 2,
      catalog_rank: 9999,
      catalog_tier: 0,
      value: 0,
      catalogValuationTier: "roster_context",
    };
    const eligible: LeanPlayer = {
      _id: "z",
      name: "Z",
      team: "NYY",
      position: "P",
      mlbId: 3,
      catalog_rank: 1,
      catalog_tier: 1,
      value: 10,
      catalogValuationTier: "valuation_eligible",
    };
    expect(isValuationEligibleCatalogRow(marketOnly)).toBe(false);
    expect(isValuationEligibleCatalogRow(rosterCtx)).toBe(false);
    expect(isValuationEligibleCatalogRow(eligible)).toBe(true);
  });

  it("normalizeCatalogPlayers preserves catalogValuationTier", () => {
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "507f1f77bcf86cd799439011",
          mlbId: 1,
          name: "A",
          team: "NYY",
          position: "P",
          catalog_rank: 1,
          catalog_tier: 1,
          value: 1,
          catalogValuationTier: "market_only",
        },
      ],
      () => undefined
    );
    expect(rows[0]?.catalogValuationTier).toBe("market_only");
  });
});
