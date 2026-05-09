import { describe, expect, it } from "vitest";
import { filterByScope, isPlayerInScope } from "../src/lib/leagueScope";
import type { LeanPlayer } from "../src/types/brain";

function row(team: string, id = 1): LeanPlayer {
  return {
    _id: "x",
    mlbId: id,
    name: "n",
    team,
    position: "OF",
    adp: 1,
    tier: 1,
    value: 1,
  };
}

describe("leagueScope / isPlayerInScope", () => {
  it("treats MLB Stats API /teams abbreviations as AL (TB, KC, CHW) and NL (AZ, SD, SF, WSH)", () => {
    expect(isPlayerInScope("TB", "AL")).toBe(true);
    expect(isPlayerInScope("KC", "AL")).toBe(true);
    expect(isPlayerInScope("CHW", "AL")).toBe(true);
    expect(isPlayerInScope("AZ", "NL")).toBe(true);
    expect(isPlayerInScope("SD", "NL")).toBe(true);
    expect(isPlayerInScope("SF", "NL")).toBe(true);
    expect(isPlayerInScope("WSH", "NL")).toBe(true);
  });

  it("accepts common legacy / fantasy abbreviations (TBR, KCR, CWS, ARI, SDP, SFG, WSN, WAS)", () => {
    expect(isPlayerInScope("TBR", "AL")).toBe(true);
    expect(isPlayerInScope("KCR", "AL")).toBe(true);
    expect(isPlayerInScope("CWS", "AL")).toBe(true);
    expect(isPlayerInScope("ARI", "NL")).toBe(true);
    expect(isPlayerInScope("SDP", "NL")).toBe(true);
    expect(isPlayerInScope("SFG", "NL")).toBe(true);
    expect(isPlayerInScope("WSN", "NL")).toBe(true);
    expect(isPlayerInScope("WAS", "NL")).toBe(true);
  });

  it("matches full MLB team names", () => {
    expect(isPlayerInScope("New York Yankees", "AL")).toBe(true);
    expect(isPlayerInScope("SAN FRANCISCO GIANTS", "NL")).toBe(true);
    expect(isPlayerInScope("ARIZONA D-BACKS", "NL")).toBe(true);
  });

  it("excludes placeholders and wrong league", () => {
    expect(isPlayerInScope("--", "AL")).toBe(false);
    expect(isPlayerInScope("--", "NL")).toBe(false);
    expect(isPlayerInScope("FA", "AL")).toBe(false);
    expect(isPlayerInScope("NYY", "NL")).toBe(false);
    expect(isPlayerInScope("LAD", "AL")).toBe(false);
  });

  it("Mixed keeps all rows", () => {
    const pool = [row("--"), row("NYY"), row("LAD")];
    expect(filterByScope(pool, "Mixed")).toHaveLength(3);
  });

  it("filterByScope keeps only matching league", () => {
    const pool = [row("NYY"), row("ATL"), row("SEA")];
    expect(filterByScope(pool, "AL").map((p) => p.team)).toEqual(["NYY", "SEA"]);
    expect(filterByScope(pool, "NL").map((p) => p.team)).toEqual(["ATL"]);
  });
});
