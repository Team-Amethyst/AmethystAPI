import { describe, expect, it } from "vitest";
import { calculateInflation } from "../src/services/inflationEngine";
import { analyzeScarcity } from "../src/services/scarcityEngine";
import type { DraftedPlayer, LeanPlayer, RosterSlot } from "../src/types/brain";

const roster: RosterSlot[] = [{ position: "OF", count: 3 }];

function mkPlayer(
  id: number,
  value: number,
  tier: number,
  position = "OF"
): LeanPlayer {
  return {
    _id: `id_${id}`,
    mlbId: id,
    name: `P${id}`,
    team: "NYY",
    position,
    adp: id,
    tier,
    value,
  };
}

describe("inflation engine properties", () => {
  it("raises inflation when less auction money is spent (fixed remaining pool value)", () => {
    const p1 = mkPlayer(1, 50, 2);
    const p2 = mkPlayer(2, 50, 2);
    const lowSpend: DraftedPlayer[] = [
      {
        player_id: "1",
        name: "P1",
        position: "OF",
        team: "NYY",
        team_id: "t1",
        paid: 1,
      },
    ];
    const highSpend: DraftedPlayer[] = [
      {
        player_id: "1",
        name: "P1",
        position: "OF",
        team: "NYY",
        team_id: "t1",
        paid: 120,
      },
    ];

    const rLow = calculateInflation(
      [p1, p2],
      lowSpend,
      100,
      2,
      roster,
      "Mixed",
      { deterministic: true, seed: 1 }
    );
    const rHigh = calculateInflation(
      [p1, p2],
      highSpend,
      100,
      2,
      roster,
      "Mixed",
      { deterministic: true, seed: 1 }
    );

    expect(rLow.inflation_factor).toBeGreaterThan(rHigh.inflation_factor);
    expect(rLow.pool_value_remaining).toBe(rHigh.pool_value_remaining);
  });

  it("linear inflation conserves total adjusted dollars vs remaining budget", () => {
    const players = [
      mkPlayer(1, 30, 2),
      mkPlayer(2, 40, 3),
      mkPlayer(3, 25, 4),
    ];
    const res = calculateInflation(
      players,
      [],
      50,
      4,
      roster,
      "Mixed",
      { deterministic: true, seed: 2 }
    );
    const sumAdjusted = res.valuations.reduce((s, v) => s + v.adjusted_value, 0);
    const pool = res.pool_value_remaining;
    const expected = pool * res.inflation_factor;
    expect(sumAdjusted).toBeCloseTo(expected, 1);
    expect(sumAdjusted).toBeCloseTo(res.total_budget_remaining, 1);
  });

  it("caps each adjusted_value at total_budget_remaining when one player remains", () => {
    const solo = mkPlayer(99, 80, 1);
    const res = calculateInflation(
      [solo],
      [],
      100,
      1,
      roster,
      "Mixed",
      { deterministic: true, seed: 3 }
    );
    expect(res.players_remaining).toBe(1);
    expect(res.valuations[0].adjusted_value).toBeLessThanOrEqual(
      res.total_budget_remaining + 0.01
    );
  });

  it("does not let player_ids shrink the inflation pool (subset rows only)", () => {
    const players = [mkPlayer(1, 30, 2), mkPlayer(2, 40, 3), mkPlayer(3, 25, 4)];
    const opts = {
      deterministic: true,
      seed: 9,
      inflationCap: 100,
      inflationFloor: 0.05,
    } as const;
    const full = calculateInflation(
      players,
      [],
      50,
      4,
      roster,
      "Mixed",
      opts
    );
    const subset = calculateInflation(
      players,
      [],
      50,
      4,
      roster,
      "Mixed",
      { ...opts, playerIdsFilter: ["1"] }
    );
    expect(subset.valuations).toHaveLength(1);
    expect(subset.players_remaining).toBe(full.players_remaining);
    expect(subset.pool_value_remaining).toBeCloseTo(full.pool_value_remaining, 5);
    expect(subset.inflation_factor).toBeCloseTo(full.inflation_factor, 7);
    expect(subset.inflation_raw).toBeCloseTo(full.inflation_raw, 7);
    expect(subset.inflation_bounded_by).toBe(full.inflation_bounded_by);
    const fullRow = full.valuations.find((v) => v.player_id === "1");
    expect(fullRow).toBeDefined();
    expect(subset.valuations[0].adjusted_value).toBeCloseTo(
      fullRow!.adjusted_value,
      5
    );
  });

  it("surplus_slots_v1 keeps sub-replacement list dollars near min bid while stars absorb surplus", () => {
    const deep = Array.from({ length: 20 }, (_, i) =>
      mkPlayer(100 + i, 2, 5, "OF")
    );
    const stars = [mkPlayer(1, 50, 1), mkPlayer(2, 40, 2), mkPlayer(3, 10, 3)];
    const players = [...stars, ...deep];
    /** 2 teams × 4 roster slots = 8 remaining picks; only stars + a few deep undrafted. */
    const res = calculateInflation(
      players,
      [],
      100,
      2,
      [
        { position: "C", count: 1 },
        { position: "OF", count: 3 },
      ],
      "Mixed",
      {
        deterministic: true,
        seed: 42,
        inflationCap: 3,
        inflationFloor: 0.25,
        inflationModel: "surplus_slots_v1",
        remainingLeagueSlots: 8,
        surplusDraftablePoolMultiplier: 1.35,
      }
    );
    expect(res.inflation_model).toBe("surplus_slots_v1");
    const star50 = res.valuations.find((v) => v.player_id === "1");
    const scrub = res.valuations.find((v) => v.player_id === "100");
    expect(star50).toBeDefined();
    expect(scrub).toBeDefined();
    expect(scrub!.adjusted_value).toBeLessThanOrEqual(2);
    expect(star50!.adjusted_value).toBeGreaterThan(star50!.baseline_value);
  });

  it("does not let player_ids shrink surplus inflation (subset rows only)", () => {
    const players = [mkPlayer(1, 30, 2), mkPlayer(2, 40, 3), mkPlayer(3, 25, 4)];
    const rosterSurplus: RosterSlot[] = [{ position: "OF", count: 5 }];
    const opts = {
      deterministic: true,
      seed: 9,
      inflationCap: 100,
      inflationFloor: 0.05,
      inflationModel: "surplus_slots_v1" as const,
      remainingLeagueSlots: 10,
    };
    const full = calculateInflation(
      players,
      [],
      50,
      4,
      rosterSurplus,
      "Mixed",
      opts
    );
    const subset = calculateInflation(
      players,
      [],
      50,
      4,
      rosterSurplus,
      "Mixed",
      { ...opts, playerIdsFilter: ["1"] }
    );
    expect(subset.valuations).toHaveLength(1);
    expect(subset.inflation_factor).toBeCloseTo(full.inflation_factor, 7);
    expect(subset.inflation_raw).toBeCloseTo(full.inflation_raw, 7);
    const fullRow = full.valuations.find((v) => v.player_id === "1");
    expect(fullRow).toBeDefined();
    expect(subset.valuations[0].adjusted_value).toBeCloseTo(
      fullRow!.adjusted_value,
      5
    );
  });

  it("does not let player_ids shrink replacement_slots_v2 inflation (subset rows only)", () => {
    const players = [mkPlayer(1, 30, 2), mkPlayer(2, 40, 3), mkPlayer(3, 25, 4)];
    const rosterV2: RosterSlot[] = [
      { position: "OF", count: 4 },
      { position: "C", count: 1 },
    ];
    const opts = {
      deterministic: true,
      seed: 9,
      inflationCap: 100,
      inflationFloor: 0.05,
      inflationModel: "replacement_slots_v2" as const,
      rosteredPlayersForSlots: [] as DraftedPlayer[],
    };
    const full = calculateInflation(
      players,
      [],
      50,
      1,
      rosterV2,
      "Mixed",
      opts
    );
    const subset = calculateInflation(
      players,
      [],
      50,
      1,
      rosterV2,
      "Mixed",
      { ...opts, playerIdsFilter: ["1"] }
    );
    expect(subset.valuations).toHaveLength(1);
    expect(subset.inflation_raw).toBeCloseTo(full.inflation_raw, 5);
    expect(subset.inflation_factor).toBeCloseTo(full.inflation_factor, 5);
    const fullRow = full.valuations.find((v) => v.player_id === "1");
    expect(fullRow).toBeDefined();
    expect(subset.valuations[0].adjusted_value).toBeCloseTo(
      fullRow!.adjusted_value,
      5
    );
  });
});

describe("scarcity engine properties", () => {
  it("flags RP cliff when almost no high-tier relievers remain", () => {
    const rps: LeanPlayer[] = [
      mkPlayer(5001, 5, 4, "RP"),
      mkPlayer(5002, 4, 4, "RP"),
    ];
    const filler: LeanPlayer[] = Array.from({ length: 40 }, (_, i) =>
      mkPlayer(10_000 + i, 2, 5, "OF")
    );
    const all = [...rps, ...filler];
    const res = analyzeScarcity(
      all,
      [],
      12,
      [{ name: "SV", type: "pitching" }],
      "Mixed"
    );
    const rp = res.positions.find((p) => p.position === "RP");
    expect(rp).toBeDefined();
    expect(rp!.scarcity_score).toBeGreaterThanOrEqual(70);
    expect(rp!.alert).not.toBeNull();
  });

  it("reports OF as stocked when elite+mid supply meets starter demand", () => {
    const ofs: LeanPlayer[] = [
      ...Array.from({ length: 12 }, (_, i) => mkPlayer(20_000 + i, 20, 1, "OF")),
      ...Array.from({ length: 24 }, (_, i) => mkPlayer(21_000 + i, 10, 2, "OF")),
    ];
    const res = analyzeScarcity(ofs, [], 12, [], "Mixed");
    const of = res.positions.find((p) => p.position === "OF");
    expect(of).toBeDefined();
    expect(of!.scarcity_score).toBe(0);
  });
});
