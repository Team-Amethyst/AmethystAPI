import { describe, expect, it } from "vitest";
import { simulateMockPicks } from "../src/services/mockPickEngine";
import type { LeanPlayer, MockPickTeam, RosterSlot } from "../src/types/brain";

const players: LeanPlayer[] = [
  {
    _id: "1",
    mlbId: 1,
    name: "SP Ace",
    team: "NYY",
    position: "SP",
    adp: 8,
    tier: 1,
    value: 40,
  },
  {
    _id: "2",
    mlbId: 2,
    name: "OF Bat",
    team: "LAD",
    position: "OF",
    adp: 12,
    tier: 1,
    value: 35,
  },
  {
    _id: "3",
    mlbId: 3,
    name: "RP Arm",
    team: "SEA",
    position: "RP",
    adp: 20,
    tier: 2,
    value: 22,
  },
];

const rosterSlots: RosterSlot[] = [
  { position: "SP", count: 1 },
  { position: "OF", count: 1 },
];

describe("simulateMockPicks", () => {
  it("prioritizes urgent positional need by ADP", () => {
    const teams: MockPickTeam[] = [{ team_id: "t1", roster: [] }];
    const out = simulateMockPicks(players, teams, ["t1"], rosterSlots);
    expect(out.predictions).toHaveLength(1);
    expect(out.predictions[0]?.predicted_player.position).toBe("SP");
    expect(out.predictions[0]?.predicted_player.name).toBe("SP Ace");
  });

  it("respects explicit available player filter", () => {
    const teams: MockPickTeam[] = [{ team_id: "t1", roster: [] }];
    const out = simulateMockPicks(
      players,
      teams,
      ["t1"],
      rosterSlots,
      ["2"]
    );
    expect(out.predictions[0]?.predicted_player.player_id).toBe("2");
  });
});
