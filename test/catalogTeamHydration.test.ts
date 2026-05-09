import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hydratePlaceholderCatalogTeamsFromMlb,
  isPlaceholderCatalogTeam,
  resetMlbTeamAbbrevCacheForTests,
} from "../src/lib/catalogTeamHydration";
import type { LeanPlayer } from "../src/types/brain";

describe("catalogTeamHydration", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    resetMlbTeamAbbrevCacheForTests();
  });

  it("isPlaceholderCatalogTeam recognizes common unknown markers", () => {
    expect(isPlaceholderCatalogTeam("--")).toBe(true);
    expect(isPlaceholderCatalogTeam("  fa  ")).toBe(true);
    expect(isPlaceholderCatalogTeam("NYY")).toBe(false);
  });

  it("hydrates -- to an abbrev from MLB-shaped responses", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/teams?")) {
        return {
          ok: true,
          json: async () => ({ teams: [{ id: 147, abbreviation: "NYY" }] }),
        } as Response;
      }
      if (u.includes("/people?")) {
        return {
          ok: true,
          json: async () => ({
            people: [{ id: 592450, currentTeam: { id: 147 } }],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const pool: LeanPlayer[] = [
      {
        _id: "1",
        mlbId: 592450,
        name: "Aaron Judge",
        team: "--",
        position: "RF",
        adp: 1,
        tier: 1,
        value: 40,
      },
    ];
    const { players, hydratedCount } =
      await hydratePlaceholderCatalogTeamsFromMlb(pool, { season: 2025 });
    expect(hydratedCount).toBe(1);
    expect(players[0]!.team).toBe("NYY");
  });
});
