import { describe, expect, it } from "vitest";
import {
  clampInflation,
  computeBudgetRemaining,
  tryBuildSurplusPlan,
} from "../src/services/inflationModel";
import type { DraftedPlayer, LeanPlayer } from "../src/types/brain";

describe("inflationModel helpers", () => {
  it("clamps to floor/cap and reports bounded_by", () => {
    expect(clampInflation(0.1, 3, 0.25).inflation_bounded_by).toBe("floor");
    expect(clampInflation(5, 3, 0.25).inflation_bounded_by).toBe("cap");
    expect(clampInflation(1.2, 3, 0.25).inflation_bounded_by).toBe("none");
  });

  it("computes budget remaining from budget map or drafted spend", () => {
    const drafted: DraftedPlayer[] = [
      {
        player_id: "1",
        name: "A",
        team: "NYY",
        team_id: "team_1",
        position: "OF",
        paid: 10,
      },
    ];
    expect(
      computeBudgetRemaining({
        draftedPlayers: drafted,
        totalBudgetPerTeam: 260,
        numTeams: 2,
        budgetByTeamId: { team_1: 120, team_2: 130 },
      })
    ).toBe(250);
    expect(
      computeBudgetRemaining({
        draftedPlayers: drafted,
        totalBudgetPerTeam: 260,
        numTeams: 2,
      })
    ).toBe(510);
  });

  it("builds surplus plan from top-k draftable slice", () => {
    const byValueFull: LeanPlayer[] = [
      { _id: "a", mlbId: 1, name: "A", team: "NYY", position: "OF", adp: 1, tier: 1, value: 30 },
      { _id: "b", mlbId: 2, name: "B", team: "NYY", position: "OF", adp: 2, tier: 1, value: 20 },
      { _id: "c", mlbId: 3, name: "C", team: "NYY", position: "OF", adp: 3, tier: 1, value: 10 },
    ];
    const plan = tryBuildSurplusPlan({
      byValueFull,
      undraftedCount: byValueFull.length,
      remainingSlots: 2,
      budgetRemaining: 200,
      minAuctionBid: 1,
      surplusDraftablePoolMultiplier: 1.0,
    });
    expect(plan).not.toBeNull();
    expect(plan!.replacementValue).toBe(20);
    expect(plan!.poolSurplusSum).toBe(10);
    expect(plan!.surplusCash).toBe(198);
  });
});
