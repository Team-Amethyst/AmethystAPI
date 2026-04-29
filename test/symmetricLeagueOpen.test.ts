import { describe, expect, it } from "vitest";
import { isSymmetricOpenLeagueContext } from "../src/lib/symmetricLeagueOpen";

describe("isSymmetricOpenLeagueContext", () => {
  it("is true with no picks, no off-board ids, empty rostered, implicit budgets", () => {
    expect(
      isSymmetricOpenLeagueContext({
        numTeams: 12,
        draftedPlayers: [],
        additionalDraftedIds: [],
        rosteredPlayersForSlots: [],
      })
    ).toBe(true);
  });

  it("is false once an auction pick exists", () => {
    expect(
      isSymmetricOpenLeagueContext({
        numTeams: 12,
        draftedPlayers: [
          {
            player_id: "x",
            name: "A",
            position: "OF",
            team: "NYY",
            team_id: "team_1",
            paid: 1,
          },
        ],
        additionalDraftedIds: [],
      })
    ).toBe(false);
  });

  it("is false when keeper/minor/taxi off-board ids are present", () => {
    expect(
      isSymmetricOpenLeagueContext({
        numTeams: 12,
        draftedPlayers: [],
        additionalDraftedIds: ["k1"],
      })
    ).toBe(false);
  });

  it("requires full budget_by_team_id with equal values when map is provided", () => {
    expect(
      isSymmetricOpenLeagueContext({
        numTeams: 3,
        draftedPlayers: [],
        additionalDraftedIds: [],
        budgetByTeamId: { team_1: 100, team_2: 100, team_3: 100 },
      })
    ).toBe(true);
    expect(
      isSymmetricOpenLeagueContext({
        numTeams: 3,
        draftedPlayers: [],
        additionalDraftedIds: [],
        budgetByTeamId: { team_1: 100, team_2: 90, team_3: 100 },
      })
    ).toBe(false);
    expect(
      isSymmetricOpenLeagueContext({
        numTeams: 3,
        draftedPlayers: [],
        additionalDraftedIds: [],
        budgetByTeamId: { team_1: 100, team_2: 100 },
      })
    ).toBe(false);
  });

  it("requires equal rostered counts per team when rostered is non-empty", () => {
    expect(
      isSymmetricOpenLeagueContext({
        numTeams: 2,
        draftedPlayers: [],
        additionalDraftedIds: [],
        rosteredPlayersForSlots: [
          {
            player_id: "a",
            name: "A",
            position: "C",
            team: "NYY",
            team_id: "team_1",
          },
          {
            player_id: "b",
            name: "B",
            position: "C",
            team: "BOS",
            team_id: "team_2",
          },
        ],
      })
    ).toBe(true);
    expect(
      isSymmetricOpenLeagueContext({
        numTeams: 2,
        draftedPlayers: [],
        additionalDraftedIds: [],
        rosteredPlayersForSlots: [
          {
            player_id: "a",
            name: "A",
            position: "C",
            team: "NYY",
            team_id: "team_1",
          },
        ],
      })
    ).toBe(false);
  });
});
