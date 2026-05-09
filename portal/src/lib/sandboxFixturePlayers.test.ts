import { describe, expect, it } from "vitest";
import { fixturePlayerBucketsFromRaw } from "./sandboxFixturePlayers";

describe("fixturePlayerBucketsFromRaw", () => {
  it("separates drafted picks from rostered players", () => {
    const raw = JSON.stringify({
      drafted_players: [
        {
          player_id: "111",
          name: "Auction Pick",
          position: "P",
          team_id: "team_a",
          paid: 10,
          pick_number: 1,
        },
      ],
      pre_draft_rosters: [
        {
          team_id: "team_a",
          players: [{ player_id: "222", name: "Keeper Kay", position: "C", team_id: "team_a", paid: 5 }],
        },
      ],
    });

    const b = fixturePlayerBucketsFromRaw(raw);
    expect(b.draftedThisSession.map((p) => p.id)).toEqual(["111"]);
    expect(b.onRosters.some((p) => p.id === "222")).toBe(true);
    expect(b.available.some((p) => p.id === "111" || p.id === "222")).toBe(false);
  });

  it("accepts numeric player_id fields", () => {
    const raw = JSON.stringify({
      drafted_players: [],
      pre_draft_rosters: [{ team_id: "t", players: [{ player_id: 661388, name: "Num Id", position: "C" }] }],
    });
    const b = fixturePlayerBucketsFromRaw(raw);
    expect(b.onRosters.some((p) => p.id === "661388")).toBe(true);
  });

  it("treats minors (and taxi) as rostered, not auction pool", () => {
    const raw = JSON.stringify({
      drafted_players: [],
      pre_draft_rosters: [],
      minors: [
        { team_id: "t", players: [{ player_id: "333", name: "Minor M", position: "P" }] },
      ],
      taxi: [],
    });
    const b = fixturePlayerBucketsFromRaw(raw);
    expect(b.available.some((p) => p.id === "333")).toBe(false);
    expect(b.onRosters.some((p) => p.id === "333")).toBe(true);
  });

  it("drops synthetic placeholder ids (not in Mongo catalog)", () => {
    const raw = JSON.stringify({
      drafted_players: [
        {
          player_id: "9000001",
          name: "Synthetic Pick",
          position: "P",
          pick_number: 1,
        },
        { player_id: "111", name: "Real Pick", position: "C", pick_number: 2 },
      ],
      pre_draft_rosters: [
        {
          team_id: "t",
          players: [
            { player_id: "9000002", name: "Synth Keeper", position: "OF" },
            { player_id: "222", name: "Real Keeper", position: "1B" },
          ],
        },
      ],
    });
    const b = fixturePlayerBucketsFromRaw(raw);
    expect(b.draftedThisSession.map((p) => p.id)).toEqual(["111"]);
    expect(b.onRosters.map((p) => p.id)).toEqual(["222"]);
  });
});
