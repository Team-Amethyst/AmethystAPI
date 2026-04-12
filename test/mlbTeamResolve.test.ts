import { describe, expect, it } from "vitest";
import { resolveMlbTeamAbbrev } from "../src/lib/mlbTeamResolve";

describe("resolveMlbTeamAbbrev", () => {
  const map = new Map<number, string>([
    [119, "LAD"],
    [147, "NYY"],
  ]);

  it("prefers explicit abbreviation on split", () => {
    expect(resolveMlbTeamAbbrev({ id: 119, abbreviation: "LAD" }, undefined, map)).toBe(
      "LAD"
    );
  });

  it("resolves from team id via map when abbreviation missing (live API shape)", () => {
    expect(resolveMlbTeamAbbrev({ id: 119 }, undefined, map)).toBe("LAD");
  });

  it("falls back to bio team id", () => {
    expect(
      resolveMlbTeamAbbrev(undefined, { id: 147, name: "Yankees" } as never, map)
    ).toBe("NYY");
  });

  it("returns -- when unknown", () => {
    expect(resolveMlbTeamAbbrev({ id: 99999 }, undefined, map)).toBe("--");
  });
});
