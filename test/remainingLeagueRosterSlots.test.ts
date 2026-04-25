import { describe, expect, it } from "vitest";
import { computeRemainingLeagueRosterSlots } from "../src/lib/remainingLeagueRosterSlots";
import type { DraftedPlayer, RosterSlot } from "../src/types/brain";

const slots: RosterSlot[] = [
  { position: "C", count: 1 },
  { position: "OF", count: 3 },
];

describe("computeRemainingLeagueRosterSlots", () => {
  it("counts capacity minus drafted and off-board ids", () => {
    const drafted: DraftedPlayer[] = [
      {
        player_id: "1",
        name: "A",
        position: "OF",
        team: "NYY",
        team_id: "t1",
        paid: 5,
      },
    ];
    const cap = (1 + 3) * 12;
    expect(
      computeRemainingLeagueRosterSlots(slots, 12, drafted, ["99", "100"])
    ).toBe(cap - 3);
  });

  it("dedupes the same id in drafted and off-board", () => {
    const drafted: DraftedPlayer[] = [
      {
        player_id: "7",
        name: "A",
        position: "OF",
        team: "NYY",
        team_id: "t1",
        paid: 1,
      },
    ];
    const cap = 4 * 2;
    expect(computeRemainingLeagueRosterSlots(slots, 2, drafted, ["7"])).toBe(
      cap - 1
    );
  });
});
