import { describe, expect, it } from "vitest";
import { calculateInflation, getPlayerId } from "../src/services/inflationEngine";
import {
  fitsRosterSlot,
  playerTokensFromLean,
  replacementLevelsFromSlotValuesPercentile,
  tokenizeFantasyPositions,
} from "../src/lib/fantasyRosterSlots";
import type { DraftedPlayer, LeanPlayer, RosterSlot } from "../src/types/brain";

function mk(
  id: number,
  value: number,
  position: string,
  tier = 2
): LeanPlayer {
  return {
    _id: `x${id}`,
    mlbId: id,
    name: `P${id}`,
    team: "NYY",
    position,
    adp: id,
    tier,
    value,
  };
}

const det = { deterministic: true, seed: 1 } as const;

function roster(
  rows: { pos: string; count: number }[],
  numTeams: number,
  drafted: DraftedPlayer[],
  players: LeanPlayer[],
  model: "global_v1" | "surplus_slots_v1" | "replacement_slots_v2",
  opts: {
    remainingLeagueSlots?: number;
    playerIdsFilter?: string[];
    budget?: number;
    inflationCap?: number;
    inflationFloor?: number;
  } = {}
) {
  const rosterSlots: RosterSlot[] = rows.map((r) => ({
    position: r.pos,
    count: r.count,
  }));
  const slotsPerTeam = rows.reduce((s, r) => s + r.count, 0);
  const remaining =
    opts.remainingLeagueSlots ?? slotsPerTeam * numTeams - drafted.length;
  return calculateInflation(
    players,
    drafted,
    opts.budget ?? 260,
    numTeams,
    rosterSlots,
    "Mixed",
    {
      ...det,
      inflationModel: model,
      remainingLeagueSlots: remaining,
      rosteredPlayersForSlots: drafted,
      playerIdsFilter: opts.playerIdsFilter,
      inflationCap: opts.inflationCap ?? 100,
      inflationFloor: opts.inflationFloor ?? 0.05,
    }
  );
}

describe("replacement_slots_v2", () => {
  it("exposes inflation_index_vs_opening_auction ≈ 1.0 with no auction picks", () => {
    const slots: RosterSlot[] = [
      { position: "C", count: 1 },
      { position: "OF", count: 2 },
    ];
    const players = [
      mk(1, 40, "C"),
      mk(2, 35, "OF"),
      ...Array.from({ length: 30 }, (_, i) => mk(200 + i, 2, "OF", 5)),
    ];
    const r = calculateInflation(players, [], 260, 12, slots, "Mixed", {
      ...det,
      inflationModel: "replacement_slots_v2",
      rosteredPlayersForSlots: [],
      inflationCap: 100,
      inflationFloor: 0.05,
    });
    expect(r.inflation_index_vs_opening_auction).toBeDefined();
    expect(r.inflation_index_vs_opening_auction!).toBeGreaterThan(0.98);
    expect(r.inflation_index_vs_opening_auction!).toBeLessThan(1.02);
  });

  it("symmetric open league: team_adjusted_value equals adjusted_value", () => {
    const slots: RosterSlot[] = [
      { position: "C", count: 1 },
      { position: "OF", count: 2 },
    ];
    const players = [
      mk(1, 40, "C"),
      mk(2, 35, "OF"),
      ...Array.from({ length: 30 }, (_, i) => mk(200 + i, 2, "OF", 5)),
    ];
    const r = calculateInflation(players, [], 260, 12, slots, "Mixed", {
      ...det,
      inflationModel: "replacement_slots_v2",
      rosteredPlayersForSlots: [],
      inflationCap: 100,
      inflationFloor: 0.05,
    });
    for (const row of r.valuations) {
      expect(row.team_adjusted_value).toBe(row.adjusted_value);
    }
  });

  it("C scarcity: shallow catcher pool lifts elite C vs global-style uniform scale", () => {
    const slots: RosterSlot[] = [
      { position: "C", count: 2 },
      { position: "OF", count: 3 },
    ];
    const players = [
      mk(1, 45, "C"),
      mk(2, 8, "C"),
      mk(3, 25, "OF"),
      ...Array.from({ length: 15 }, (_, i) => mk(100 + i, 4, "OF", 5)),
    ];
    const g = calculateInflation(
      players,
      [],
      100,
      1,
      slots,
      "Mixed",
      { ...det, inflationModel: "global_v1", inflationCap: 10, inflationFloor: 0.05 }
    );
    const v2 = calculateInflation(
      players,
      [],
      100,
      1,
      slots,
      "Mixed",
      {
        ...det,
        inflationModel: "replacement_slots_v2",
        rosteredPlayersForSlots: [],
        inflationCap: 10,
        inflationFloor: 0.05,
      }
    );
    const eliteC = v2.valuations.find((v) => v.player_id === "1")!;
    const globalEliteC = g.valuations.find((v) => v.player_id === "1")!;
    expect(v2.inflation_model).toBe("replacement_slots_v2");
    expect(eliteC.adjusted_value).toBeGreaterThan(globalEliteC.adjusted_value);
    expect(v2.replacement_values_by_slot_or_position?.C ?? 0).toBeGreaterThan(0);
  });

  it("OF depth: many similar OF should not explode mid-tier prices", () => {
    const ofs = Array.from({ length: 30 }, (_, i) =>
      mk(200 + i, 12 + (i % 3), "OF", 3)
    );
    const r = roster(
      [{ pos: "OF", count: 8 }],
      1,
      [],
      ofs,
      "replacement_slots_v2",
      { budget: 180, inflationCap: 5, inflationFloor: 0.1 }
    );
    const mids = r.valuations.filter((v) => v.baseline_value >= 12 && v.baseline_value <= 14);
    expect(mids.length).toBeGreaterThan(5);
    const maxAdj = Math.max(...mids.map((m) => m.adjusted_value));
    expect(maxAdj).toBeLessThan(80);
  });

  it("multi-position: 2B/SS eligible player uses best surplus slot (MI vs 2B)", () => {
    const players = [
      mk(1, 35, "2B/SS"),
      mk(2, 5, "2B"),
      mk(3, 5, "SS"),
    ];
    const r = roster(
      [
        { pos: "2B", count: 1 },
        { pos: "SS", count: 1 },
        { pos: "MI", count: 1 },
      ],
      1,
      [],
      players,
      "replacement_slots_v2",
      { budget: 120 }
    );
    expect(r.replacement_values_by_slot_or_position).toBeDefined();
    expect(r.fallback_reason).toBeNull();
    const star = r.valuations.find((v) => v.player_id === "1")!;
    expect(star.adjusted_value).toBeGreaterThan(star.baseline_value);
  });

  it("UTIL accepts hitters but not SP-only", () => {
    expect(fitsRosterSlot("UTIL", tokenizeFantasyPositions("1B", undefined))).toBe(
      true
    );
    expect(fitsRosterSlot("UTIL", tokenizeFantasyPositions("SP", undefined))).toBe(
      false
    );
  });

  it("P / SP / RP demand produces distinct replacement keys", () => {
    const players = [
      mk(1, 40, "SP"),
      mk(2, 35, "SP"),
      mk(3, 8, "RP"),
      mk(4, 6, "RP"),
    ];
    const r = roster(
      [
        { pos: "SP", count: 2 },
        { pos: "RP", count: 1 },
        { pos: "P", count: 1 },
      ],
      1,
      [],
      players,
      "replacement_slots_v2",
      { budget: 200 }
    );
    const rep = r.replacement_values_by_slot_or_position ?? {};
    expect(Object.keys(rep).length).toBeGreaterThan(0);
    expect(r.total_surplus_mass ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("endgame: few remaining slots concentrates surplus on top players", () => {
    const players = [
      mk(1, 60, "OF"),
      mk(2, 50, "OF"),
      ...Array.from({ length: 20 }, (_, i) => mk(10 + i, 3, "OF", 5)),
    ];
    const drafted: DraftedPlayer[] = Array.from({ length: 20 }, (_, i) => ({
      player_id: String(10 + i),
      name: `D${i}`,
      position: "OF",
      team: "NYY",
      team_id: "t1",
      paid: 1,
    }));
    const r = roster([{ pos: "OF", count: 3 }], 12, drafted, players, "replacement_slots_v2", {
      budget: 400,
      inflationCap: 15,
      inflationFloor: 0.05,
    });
    const top = r.valuations.find((v) => v.player_id === "1")!;
    expect(top.adjusted_value).toBeGreaterThan(top.baseline_value);
    expect(r.surplus_cash ?? 0).toBeGreaterThan(0);
  });

  it("zero surplus cash: prices collapse toward min_bid", () => {
    const players = [mk(1, 30, "OF"), mk(2, 20, "OF")];
    const r = roster([{ pos: "OF", count: 5 }], 1, [], players, "replacement_slots_v2", {
      budget: 5,
    });
    expect(r.fallback_reason).toBe("no_surplus_cash");
    expect(r.inflation_factor).toBe(0);
    for (const v of r.valuations) {
      expect(v.adjusted_value).toBeLessThanOrEqual(2);
    }
  });

  it("player_ids does not change v2 inflation for the same player row", () => {
    const players = [mk(1, 30, "OF"), mk(2, 25, "OF"), mk(3, 20, "OF")];
    const full = roster([{ pos: "OF", count: 4 }], 1, [], players, "replacement_slots_v2", {
      budget: 150,
    });
    const sub = roster([{ pos: "OF", count: 4 }], 1, [], players, "replacement_slots_v2", {
      budget: 150,
      playerIdsFilter: ["1"],
    });
    expect(sub.valuations).toHaveLength(1);
    expect(sub.inflation_raw).toBeCloseTo(full.inflation_raw, 5);
    expect(sub.inflation_factor).toBeCloseTo(full.inflation_factor, 5);
    const row = full.valuations.find((v) => v.player_id === "1")!;
    expect(sub.valuations[0].adjusted_value).toBeCloseTo(row.adjusted_value, 4);
  });

  it("all three inflation models return finite aggregates with metadata", () => {
    const players = [mk(1, 20, "C"), mk(2, 15, "C")];
    const slots: RosterSlot[] = [{ position: "C", count: 2 }];
    for (const model of [
      "global_v1",
      "surplus_slots_v1",
      "replacement_slots_v2",
    ] as const) {
      const r = calculateInflation(
        players,
        [],
        50,
        1,
        slots,
        "Mixed",
        {
          ...det,
          inflationModel: model,
          remainingLeagueSlots: 2,
          rosteredPlayersForSlots: [],
          inflationCap: 50,
          inflationFloor: 0.05,
        }
      );
      expect(Number.isFinite(r.inflation_raw)).toBe(true);
      expect(Number.isFinite(r.inflation_factor)).toBe(true);
      expect(Number.isFinite(r.pool_value_remaining)).toBe(true);
      if (model === "replacement_slots_v2") {
        expect(r.remaining_slots).toBeDefined();
        expect(r.min_bid).toBe(1);
      }
    }
  });

  it("sanity: nonnegative adjusted; scrubs near min_bid; ordering mostly by baseline", () => {
    const players = [
      mk(1, 50, "1B"),
      mk(2, 40, "1B"),
      mk(3, 2, "1B", 6),
    ];
    const r = roster([{ pos: "1B", count: 3 }], 1, [], players, "replacement_slots_v2", {
      budget: 120,
    });
    for (const v of r.valuations) {
      expect(v.adjusted_value).toBeGreaterThanOrEqual(0);
    }
    const scrub = r.valuations.find((v) => v.player_id === "3")!;
    expect(scrub.adjusted_value).toBeLessThanOrEqual(5);
    expect(
      r.valuations.find((v) => v.player_id === "1")!.adjusted_value
    ).toBeGreaterThan(r.valuations.find((v) => v.player_id === "2")!.adjusted_value - 0.01);
  });

  it("no_remaining_slots: adjusted tracks baseline with fallback_reason", () => {
    const slots: RosterSlot[] = [{ position: "OF", count: 1 }];
    const drafted: DraftedPlayer[] = [
      {
        player_id: "1",
        name: "A",
        position: "OF",
        team: "NYY",
        team_id: "t1",
        paid: 1,
      },
    ];
    const players = [mk(1, 40, "OF"), mk(2, 10, "OF")];
    const r = calculateInflation(players, drafted, 100, 1, slots, "Mixed", {
      ...det,
      inflationModel: "replacement_slots_v2",
      rosteredPlayersForSlots: drafted,
      inflationCap: 5,
      inflationFloor: 0.1,
    });
    expect(r.fallback_reason).toBe("no_remaining_slots");
    const row = r.valuations.find((v) => v.player_id === "2");
    expect(row?.adjusted_value).toBeCloseTo(row?.baseline_value ?? 0, 4);
  });
});

describe("fantasyRosterSlots helpers", () => {
  it("replacement percentile uses lower-tail floor, not strict min", () => {
    const slotValues = new Map<string, number[]>([
      ["SP", [1, 4, 7, 10, 15]],
      ["RP", [2, 3, 5, 8]],
    ]);
    const keys = new Set<string>(["SP", "RP"]);
    const minLike = replacementLevelsFromSlotValuesPercentile(
      slotValues,
      keys,
      {},
      0
    );
    const tailLike = replacementLevelsFromSlotValuesPercentile(
      slotValues,
      keys,
      {},
      0.35
    );
    expect(minLike.SP).toBe(1);
    expect(tailLike.SP).toBeGreaterThan(minLike.SP);
    expect(tailLike.RP).toBeGreaterThan(minLike.RP);
  });

  it("tokenizes slash and comma positions", () => {
    const t = tokenizeFantasyPositions("2B / SS", ["OF"]);
    expect(new Set(t)).toEqual(new Set(["2B", "SS", "OF"]));
  });

  it("normalizes LF/CF/RF to OF", () => {
    expect(fitsRosterSlot("OF", tokenizeFantasyPositions("LF"))).toBe(true);
    expect(fitsRosterSlot("OF", tokenizeFantasyPositions("CF"))).toBe(true);
    expect(fitsRosterSlot("OF", tokenizeFantasyPositions("RF"))).toBe(true);
  });

  it("pitcher token rules: P fits P; SP fits SP+P; RP fits RP+P", () => {
    const p = tokenizeFantasyPositions("P");
    const sp = tokenizeFantasyPositions("SP");
    const rp = tokenizeFantasyPositions("RP");
    expect(fitsRosterSlot("P", p)).toBe(true);
    expect(fitsRosterSlot("SP", p)).toBe(true);
    expect(fitsRosterSlot("RP", p)).toBe(true);
    expect(fitsRosterSlot("SP", sp)).toBe(true);
    expect(fitsRosterSlot("P", sp)).toBe(true);
    expect(fitsRosterSlot("RP", rp)).toBe(true);
    expect(fitsRosterSlot("P", rp)).toBe(true);
  });

  it("P does not fit hitter slots and UTIL stays hitter-only", () => {
    const p = tokenizeFantasyPositions("P");
    expect(fitsRosterSlot("1B", p)).toBe(false);
    expect(fitsRosterSlot("OF", p)).toBe(false);
    expect(fitsRosterSlot("UTIL", p)).toBe(false);
    expect(fitsRosterSlot("UTIL", tokenizeFantasyPositions("1B"))).toBe(true);
  });

  it("getPlayerId matches rostered id strings", () => {
    const p = mk(42, 1, "C");
    expect(getPlayerId(p)).toBe("42");
  });

  it("Judge/Skubal eligibility no longer collapse to empty slot fit in v2", () => {
    const players = [
      mk(1, 114, "RF"),
      mk(2, 103, "P"),
      mk(3, 60, "OF"),
      mk(4, 55, "SP"),
      mk(5, 52, "RP"),
      mk(6, 15, "OF", 4),
      mk(7, 14, "P", 4),
    ];
    const slots: RosterSlot[] = [
      { position: "OF", count: 3 },
      { position: "P", count: 3 },
      { position: "UTIL", count: 1 },
    ];
    const r = calculateInflation(players, [], 260, 1, slots, "Mixed", {
      ...det,
      inflationModel: "replacement_slots_v2",
      rosteredPlayersForSlots: [],
      inflationCap: 10,
      inflationFloor: 0.05,
    });
    const judge = r.valuations.find((v) => v.player_id === "1")!;
    const skubal = r.valuations.find((v) => v.player_id === "2")!;
    expect(fitsRosterSlot("OF", tokenizeFantasyPositions("RF"))).toBe(true);
    expect(fitsRosterSlot("P", tokenizeFantasyPositions("P"))).toBe(true);
    expect(judge.adjusted_value).toBeGreaterThan(1);
    expect(skubal.adjusted_value).toBeGreaterThan(1);
  });

  it("generic catalog P token is inferred to SP/RP for slot fit", () => {
    const spLike: LeanPlayer = {
      ...mk(10, 30, "P"),
      projection: { pitching: { saves: 1, starts: 25, innings_pitched: 160 } },
    };
    const rpLike: LeanPlayer = {
      ...mk(11, 30, "P"),
      projection: { pitching: { saves: 25, starts: 0, innings_pitched: 62 } },
    };
    const hybridLike: LeanPlayer = {
      ...mk(12, 30, "P"),
      projection: { pitching: { saves: 8, starts: 12, innings_pitched: 95 } },
    };
    const spTokens = playerTokensFromLean(spLike);
    const rpTokens = playerTokensFromLean(rpLike);
    const hybridTokens = playerTokensFromLean(hybridLike);
    expect(spTokens.includes("SP")).toBe(true);
    expect(fitsRosterSlot("SP", spTokens)).toBe(true);
    expect(rpTokens.includes("RP")).toBe(true);
    expect(fitsRosterSlot("RP", rpTokens)).toBe(true);
    expect(hybridTokens.includes("SP")).toBe(true);
    expect(hybridTokens.includes("RP")).toBe(true);
  });

  it("generic P starter no longer collapses to BN-level replacement in SP/RP leagues", () => {
    const players = [
      {
        ...mk(20, 68, "P", 1),
        projection: { pitching: { saves: 0 } },
      } as LeanPlayer,
      mk(21, 65, "SP", 1),
      mk(22, 40, "SP", 2),
      mk(23, 35, "RP", 2),
      ...Array.from({ length: 20 }, (_, i) => mk(200 + i, 15 - (i % 6), i % 2 ? "SP" : "RP", 4)),
    ];
    const r = roster(
      [
        { pos: "SP", count: 5 },
        { pos: "RP", count: 2 },
        { pos: "BN", count: 3 },
      ],
      1,
      [],
      players,
      "replacement_slots_v2",
      { budget: 260, inflationCap: 5, inflationFloor: 0.05 }
    );
    const genericP = r.valuations.find((v) => v.player_id === "20")!;
    const peerSp = r.valuations.find((v) => v.player_id === "21")!;
    expect(genericP.adjusted_value).toBeGreaterThan(1);
    expect(genericP.adjusted_value).toBeGreaterThanOrEqual(peerSp.adjusted_value * 0.75);
  });
});
