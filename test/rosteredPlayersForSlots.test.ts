import { describe, expect, it } from "vitest";
import { computeReplacementSlotsV2 } from "../src/services/replacementSlotsV2";
import {
  buildRosteredPlayersForSlotEngine,
  isReserveRosterSlotForEngine,
} from "../src/lib/rosteredPlayersForSlots";
import type {
  DraftedPlayer,
  LeanPlayer,
  NormalizedValuationInput,
  RosterSlot,
} from "../src/types/brain";
import { getPlayerId } from "../src/lib/playerId";

function mkLean(id: string, value: number, position: string): LeanPlayer {
  return {
    _id: id,
    mlbId: Number(id) || 0,
    name: `P-${id}`,
    team: "NYY",
    position,
    catalog_rank: 1,
    tier: 2,
    value,
  };
}

function mkDrafted(
  id: string,
  teamId: string,
  position: string,
  rosterSlot?: string
): DraftedPlayer {
  return {
    player_id: id,
    name: id,
    position,
    team: "NYY",
    team_id: teamId,
    ...(rosterSlot ? { roster_slot: rosterSlot } : {}),
  };
}

describe("buildRosteredPlayersForSlotEngine", () => {
  it("excludes MIN/TAXI from slot consumption but keeps keepers", () => {
    expect(isReserveRosterSlotForEngine("MIN")).toBe(true);
    expect(isReserveRosterSlotForEngine("TAXI")).toBe(true);
    expect(isReserveRosterSlotForEngine("OF")).toBe(false);

    const input: NormalizedValuationInput = {
      schemaVersion: "1.0.0",
      roster_slots: [{ position: "OF", count: 2 }],
      scoring_categories: [{ name: "HR", type: "batting" }],
      total_budget: 260,
      num_teams: 1,
      league_scope: "Mixed",
      drafted_players: [],
      pre_draft_rosters: {
        team_1: [
          {
            player_id: "keeper-of",
            name: "Keeper",
            position: "OF",
            team: "NYY",
            team_id: "team_1",
            roster_slot: "OF",
            is_keeper: true,
          },
        ],
      },
      minors: [
        {
          team_id: "team_1",
          players: [
            {
              player_id: "min1",
              name: "Minor",
              position: "OF",
              team: "NYY",
              team_id: "team_1",
              roster_slot: "MIN",
            },
          ],
        },
      ],
    };

    const rostered = buildRosteredPlayersForSlotEngine(input);
    expect(rostered.map((r) => r.player_id)).toEqual(["keeper-of"]);
  });

  it("higher remaining_slots when minors are not slot consumers", () => {
    const rosterSlots: RosterSlot[] = [
      { position: "OF", count: 3 },
      { position: "UTIL", count: 1 },
    ];
    const numTeams = 1;
    const undrafted: LeanPlayer[] = [
      mkLean("star", 45, "OF"),
      ...Array.from({ length: 20 }, (_, i) => mkLean(`f${i}`, 5, "OF")),
    ];
    const baselineById = new Map(undrafted.map((p) => [getPlayerId(p), p.value || 0]));

    const keepers: DraftedPlayer[] = [
      mkDrafted("k0", "team_1", "OF", "OF"),
      mkDrafted("k1", "team_1", "OF", "OF"),
    ];
    const minorsGreedy: DraftedPlayer[] = [
      ...keepers,
      mkDrafted("m0", "team_1", "OF", "MIN"),
      mkDrafted("m1", "team_1", "OF", "MIN"),
    ];

    const withMinors = computeReplacementSlotsV2(
      undrafted,
      minorsGreedy,
      rosterSlots,
      numTeams,
      200,
      baselineById,
      { deterministic: true, seed: 1 }
    );
    const activeOnly = computeReplacementSlotsV2(
      undrafted,
      keepers,
      rosterSlots,
      numTeams,
      200,
      baselineById,
      { deterministic: true, seed: 1 }
    );

    expect(activeOnly.remaining_slots).toBeGreaterThan(withMinors.remaining_slots);
    const starWithMinors =
      withMinors.playerIdToSurplusBasis.get("star") ?? 0;
    const starActive =
      activeOnly.playerIdToSurplusBasis.get("star") ?? 0;
    expect(starActive).toBeLessThanOrEqual(starWithMinors);
  });
});
