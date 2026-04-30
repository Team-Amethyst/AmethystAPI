import { describe, expect, it } from "vitest";
import {
  buildOpenSlotsForUserTeam,
  computeTeamAdjustedValue,
  teamAdjustedMultipliers,
} from "../src/services/teamAdjustedValue";
import type { LeanPlayer, RosterSlot, ValuedPlayer } from "../src/types/brain";

describe("teamAdjustedValue helpers", () => {
  it("tracks open slots after filling from rostered rows", () => {
    const slots: RosterSlot[] = [
      { position: "C", count: 1 },
      { position: "OF", count: 2 },
    ];
    const open = buildOpenSlotsForUserTeam(
      slots,
      [
        {
          player_id: "1",
          name: "Catcher",
          team: "NYY",
          team_id: "team_1",
          position: "C",
        },
      ],
      "team_1"
    );
    expect(open.get("C")).toBe(0);
    expect(open.get("OF")).toBe(2);
  });

  it("returns multipliers and computes team adjusted value", () => {
    const row: ValuedPlayer = {
      player_id: "100",
      name: "OF A",
      position: "OF",
      team: "NYY",
      adp: 20,
      tier: 2,
      baseline_value: 30,
      adjusted_value: 20,
      indicator: "Fair Value",
      inflation_factor: 1.0,
    };
    const lp: LeanPlayer = {
      _id: "100",
      mlbId: 100,
      name: "OF A",
      team: "NYY",
      position: "OF",
      adp: 20,
      tier: 2,
      value: 30,
    };
    const multipliers = teamAdjustedMultipliers({
      row,
      lp,
      openSlots: new Map([["OF", 1]]),
      budgetMult: 1,
      dpsMult: 1,
      slotScarcityMult: 1,
      replForTeam: { OF: 10 },
      rosterSlotKeysForFit: new Set(["OF"]),
    });
    expect(multipliers.need).toBeGreaterThan(1);
    const tav = computeTeamAdjustedValue({ row, multipliers });
    expect(tav).toBeGreaterThan(row.adjusted_value);
  });
});
