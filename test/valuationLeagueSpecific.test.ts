import { describe, expect, it } from "vitest";
import { calculateInflation } from "../src/services/inflationEngine";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { computeReplacementSlotsV2 } from "../src/services/replacementSlotsV2";
import type { DraftedPlayer, LeanPlayer } from "../src/types/brain";

function mkHitter(
  id: string,
  team: string,
  proj: Record<string, unknown>,
  catalogValue = 25
): LeanPlayer {
  return {
    _id: id,
    mlbId: Number(id),
    name: `p-${id}`,
    team,
    position: "OF",
    catalog_rank: 50,
    catalog_tier: 3,
    value: catalogValue,
    projection: { batting: proj },
  };
}

function mkSp(id: string, team: string, proj: Record<string, unknown>, catalogValue = 22): LeanPlayer {
  return {
    _id: id,
    mlbId: Number(id),
    name: `p-${id}`,
    team,
    position: "SP",
    catalog_rank: 60,
    catalog_tier: 3,
    value: catalogValue,
    projection: { pitching: proj },
  };
}

describe("valuation universe + baseline", () => {
  it("AL-only pool excludes NL players from roto z-score baselines", () => {
    const al = mkHitter("101", "NYY", {
      hr: 25,
      rbi: 80,
      runs: 85,
      sb: 10,
      avg: 0.265,
      atBats: 580,
      obp: 0.34,
      plateAppearances: 620,
    });
    const nl = mkHitter("102", "ATL", {
      hr: 40,
      rbi: 110,
      runs: 100,
      sb: 15,
      avg: 0.29,
      atBats: 560,
      obp: 0.38,
      plateAppearances: 610,
    });
    const mixed = scoringAwareBaselinePlayers(
      [al, nl],
      "5x5",
      [
        { name: "HR", type: "batting" },
        { name: "RBI", type: "batting" },
      ],
      [{ position: "OF", count: 3 }]
    );
    const alOnly = scoringAwareBaselinePlayers(
      filterValuationUniverse([al, nl], { leagueScope: "AL" }),
      "5x5",
      [
        { name: "HR", type: "batting" },
        { name: "RBI", type: "batting" },
      ],
      [{ position: "OF", count: 3 }]
    );
    const alRowMixed = mixed.find((p) => String(p.mlbId) === "101")!;
    const alRowAlOnly = alOnly.find((p) => String(p.mlbId) === "101")!;
    expect(alRowMixed.value).not.toBeCloseTo(alRowAlOnly.value, 5);
  });

  it("eligible_player_ids narrows replacement v2 inflation vs full pool", () => {
    const players: LeanPlayer[] = [
      mkHitter("1", "NYY", {
        hr: 35,
        rbi: 100,
        runs: 95,
        sb: 8,
        avg: 0.285,
        atBats: 580,
        obp: 0.36,
        plateAppearances: 640,
      }),
      mkHitter("2", "LAD", {
        hr: 30,
        rbi: 90,
        runs: 90,
        sb: 12,
        avg: 0.28,
        atBats: 570,
        obp: 0.35,
        plateAppearances: 630,
      }),
      mkSp("3", "HOU", {
        strikeouts: 220,
        wins: 14,
        saves: 0,
        era: "3.20",
        whip: "1.08",
        innings: "185",
      }),
    ];
    const rosterSlots = [{ position: "OF", count: 2 }];
    const baseFull = scoringAwareBaselinePlayers(
      players,
      "5x5",
      [
        { name: "HR", type: "batting" },
        { name: "ERA", type: "pitching" },
      ],
      rosterSlots
    );
    const baseEligible = scoringAwareBaselinePlayers(
      filterValuationUniverse(players, {
        leagueScope: "Mixed",
        eligiblePlayerIds: ["1"],
      }),
      "5x5",
      [
        { name: "HR", type: "batting" },
        { name: "ERA", type: "pitching" },
      ],
      rosterSlots
    );
    const drafted: DraftedPlayer[] = [];
    const full = calculateInflation(baseFull, drafted, 100, 1, rosterSlots, "Mixed", {
      rosteredPlayersForSlots: [],
      inflationModel: "replacement_slots_v2",
      deterministic: true,
      seed: 1,
      inflationCap: 100,
      inflationFloor: 0.01,
    });
    const elig = calculateInflation(baseEligible, drafted, 100, 1, rosterSlots, "Mixed", {
      rosteredPlayersForSlots: [],
      inflationModel: "replacement_slots_v2",
      deterministic: true,
      seed: 1,
      inflationCap: 100,
      inflationFloor: 0.01,
    });
    expect(full.inflation_raw).not.toBeCloseTo(elig.inflation_raw, 4);
    const one = elig.valuations.find((v) => v.player_id === "1");
    expect(one).toBeDefined();
    expect(one!.auction_value).toBe(one!.adjusted_value);
  });

  it("player_ids does not shrink inflation factor (subset rows only)", () => {
    const players: LeanPlayer[] = [
      mkHitter("1", "NYY", {
        hr: 35,
        rbi: 100,
        runs: 95,
        sb: 8,
        avg: 0.285,
        atBats: 580,
        obp: 0.36,
        plateAppearances: 640,
      }),
      mkHitter("2", "LAD", {
        hr: 25,
        rbi: 85,
        runs: 88,
        sb: 7,
        avg: 0.275,
        atBats: 570,
        obp: 0.34,
        plateAppearances: 630,
      }),
    ];
    const rosterSlots = [{ position: "OF", count: 4 }];
    const base = scoringAwareBaselinePlayers(
      players,
      "5x5",
      [{ name: "HR", type: "batting" }],
      rosterSlots
    );
    const full = calculateInflation(base, [], 100, 1, rosterSlots, "Mixed", {
      inflationModel: "replacement_slots_v2",
      deterministic: true,
      seed: 2,
      inflationCap: 100,
      inflationFloor: 0.01,
      rosteredPlayersForSlots: [],
    });
    const sub = calculateInflation(base, [], 100, 1, rosterSlots, "Mixed", {
      inflationModel: "replacement_slots_v2",
      deterministic: true,
      seed: 2,
      inflationCap: 100,
      inflationFloor: 0.01,
      rosteredPlayersForSlots: [],
      playerIdsFilter: ["1"],
    });
    expect(sub.valuations).toHaveLength(1);
    expect(sub.inflation_raw).toBeCloseTo(full.inflation_raw, 5);
  });

  it("low AB high AVG hitter is not valued above similar-rate full-timer", () => {
    const fullTimer = mkHitter("201", "NYY", {
      hr: 18,
      rbi: 72,
      runs: 78,
      sb: 6,
      avg: 0.272,
      atBats: 580,
      obp: 0.34,
      plateAppearances: 640,
    });
    const platoon = mkHitter("202", "BOS", {
      hr: 6,
      rbi: 28,
      runs: 32,
      sb: 3,
      avg: 0.33,
      atBats: 120,
      obp: 0.39,
      plateAppearances: 135,
    });
    const out = scoringAwareBaselinePlayers(
      [fullTimer, platoon],
      "5x5",
      [
        { name: "AVG", type: "batting" },
        { name: "HR", type: "batting" },
      ],
      [{ position: "OF", count: 3 }]
    );
    const vFull = out.find((p) => String(p.mlbId) === "201")!.value;
    const vPart = out.find((p) => String(p.mlbId) === "202")!.value;
    expect(vFull).toBeGreaterThan(vPart);
  });

  it("low IP starter does not beat full workload on counting pitching categories", () => {
    const horse = mkSp("301", "NYY", {
      strikeouts: 190,
      wins: 13,
      saves: 0,
      era: "3.85",
      whip: "1.22",
      innings: "185",
    });
    const spot = mkSp("302", "TBR", {
      strikeouts: 55,
      wins: 3,
      saves: 0,
      era: "2.65",
      whip: "1.05",
      innings: "42",
    });
    const out = scoringAwareBaselinePlayers(
      [horse, spot],
      "5x5",
      [
        { name: "K", type: "pitching" },
        { name: "W", type: "pitching" },
      ],
      [{ position: "SP", count: 4 }]
    );
    const vHorse = out.find((p) => String(p.mlbId) === "301")!.value;
    const vSpot = out.find((p) => String(p.mlbId) === "302")!.value;
    expect(vHorse).toBeGreaterThan(vSpot);
  });

  it("replacement_slots_v2 maps surplus cash to surplus mass (approx conservation)", () => {
    const players: LeanPlayer[] = Array.from({ length: 12 }, (_, i) =>
      mkHitter(String(400 + i), "NYY", {
        hr: 15 + i,
        rbi: 70,
        runs: 75,
        sb: 8,
        avg: 0.26 + i * 0.001,
        atBats: 550,
        obp: 0.33,
        plateAppearances: 600,
      })
    );
    const rosterSlots = [{ position: "OF", count: 4 }];
    const base = scoringAwareBaselinePlayers(
      players,
      "5x5",
      [{ name: "HR", type: "batting" }],
      rosterSlots
    );
    const baselineById = new Map(base.map((p) => [String(p.mlbId), p.value]));
    const rostered: DraftedPlayer[] = [];
    const r = computeReplacementSlotsV2(
      base,
      rostered,
      rosterSlots,
      1,
      180,
      baselineById,
      { deterministic: true, seed: 3 }
    );
    if (r.surplus_cash > 0 && r.total_surplus_mass > 0 && !r.skip_inflation_clamp) {
      expect(r.inflation_raw * r.total_surplus_mass).toBeCloseTo(r.surplus_cash, 4);
    }
  });
});
