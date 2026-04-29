import { describe, expect, it, vi } from "vitest";
import { playerTokensFromLean } from "../src/lib/fantasyRosterSlots";
import type { LeanPlayer } from "../src/types/brain";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";

describe("normalizeCatalogPlayers", () => {
  it("coerces invalid value and adp with callbacks", () => {
    const warn = vi.fn();
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: 1,
          name: "Good",
          team: "NYY",
          position: "OF",
          value: 10,
          adp: 5,
          tier: 1,
        },
        {
          _id: "b",
          mlbId: 2,
          name: "Bad nums",
          team: "BOS",
          position: "SP",
          value: "x",
          adp: Number.NaN,
          tier: "nope",
        },
      ],
      warn
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.value).toBe(10);
    expect(rows[1]!.value).toBe(0);
    expect(rows[1]!.adp).toBe(9999);
    expect(rows[1]!.tier).toBe(0);
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("skips non-objects", () => {
    const rows = normalizeCatalogPlayers([null, "x", { name: "Ok", value: 1 }], () => {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ok");
  });

  it("passes through positions[] for slot/surplus eligibility", () => {
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: 1,
          name: "TwoWay",
          team: "LAD",
          position: "SP",
          positions: ["DH"],
          value: 95,
          adp: 2,
          tier: 1,
        },
      ],
      () => {}
    );
    expect(rows[0]!.positions).toEqual(["DH"]);
  });

  it("playerTokensFromLean uses positions for v2 slot eligibility (two-way)", () => {
    const p: LeanPlayer = {
      _id: "o",
      mlbId: 660271,
      name: "Ohtani",
      team: "LAD",
      position: "SP",
      positions: ["DH"],
      adp: 2,
      tier: 1,
      value: 95,
    };
    const t = playerTokensFromLean(p);
    expect(t).toContain("SP");
    expect(t).toContain("DH");
  });
});
