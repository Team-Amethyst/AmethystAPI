import { describe, expect, it, vi } from "vitest";
import { playerTokensFromLean } from "../src/lib/fantasyRosterSlots";
import type { LeanPlayer } from "../src/types/brain";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";

describe("normalizeCatalogPlayers", () => {
  it("coerces invalid value and legacy adp/tier with callbacks", () => {
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
          catalog_rank: 5,
          catalog_tier: 1,
        },
        {
          _id: "b",
          mlbId: 2,
          name: "Bad nums",
          team: "BOS",
          position: "SP",
          value: "x",
          catalog_rank: Number.NaN,
          tier: "nope",
        },
      ],
      warn
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.value).toBe(10);
    expect(rows[1]!.value).toBe(0);
    expect(rows[1]!.catalog_rank).toBe(9999);
    expect(rows[1]!.catalog_tier).toBe(0);
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("coerces numeric-string mlbId and clamps negative tier", () => {
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: "660271",
          name: "ID Parse",
          team: "LAD",
          position: "DH",
          value: 10,
          catalog_rank: 5,
          catalog_tier: -4,
        },
      ],
      () => {}
    );
    expect(rows[0]!.mlbId).toBe(660271);
    expect(rows[0]!.catalog_tier).toBe(0);
  });

  it("skips non-objects", () => {
    const rows = normalizeCatalogPlayers([null, "x", { name: "Ok", value: 1 }], () => {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ok");
  });

  it("parses positions from a comma-separated string", () => {
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: 2,
          name: "Multi",
          team: "NYY",
          position: "2B",
          positions: "SS,3B",
          value: 10,
          catalog_rank: 5,
          catalog_tier: 1,
        },
      ],
      () => {}
    );
    expect(rows[0]!.positions).toEqual(["SS", "3B"]);
  });

  it("coerces injury severity from injury_severity or injurySeverity", () => {
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: 9,
          name: "IL",
          team: "NYY",
          position: "OF",
          value: 10,
          catalog_rank: 5,
          catalog_tier: 2,
          injury_severity: 2,
        },
        {
          _id: "b",
          mlbId: 10,
          name: "Fine",
          team: "BOS",
          position: "SP",
          value: 10,
          catalog_rank: 5,
          catalog_tier: 2,
          injurySeverity: 0,
        },
      ],
      () => {}
    );
    expect(rows[0]!.injurySeverity).toBe(2);
    expect(rows[1]!.injurySeverity).toBeUndefined();
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
          catalog_rank: 2,
          catalog_tier: 1,
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
      catalog_rank: 2,
      catalog_tier: 1,
      value: 95,
    };
    const t = playerTokensFromLean(p);
    expect(t).toContain("SP");
    expect(t).toContain("DH");
  });
});
