import { describe, expect, it } from "vitest";
import {
  assessCatalogProjectionHealth,
  isBaselineOutputCollapsed,
} from "../src/lib/catalogProjectionHealth";
import type { LeanPlayer } from "../src/types/brain";

function makePlayer(
  idx: number,
  overrides: Partial<LeanPlayer> = {}
): LeanPlayer {
  return {
    name: `Player ${idx}`,
    team: "TEX",
    position: "OF",
    catalog_rank: idx,
    catalog_tier: 1,
    value: 50 - idx,
    projection: {
      batting: { hr: 20 + idx, runs: 70 + idx, rbi: 65, sb: 5, avg: "0.27" },
      pitching: {},
    },
    ...overrides,
  } as LeanPlayer;
}

function pitcher(idx: number, overrides: Partial<LeanPlayer> = {}): LeanPlayer {
  return {
    name: `Pitcher ${idx}`,
    team: "NYY",
    position: "P",
    catalog_rank: idx,
    catalog_tier: 1,
    value: 40 - idx,
    projection: {
      batting: {},
      pitching: {
        strikeouts: 150 + idx,
        innings: 180 - idx,
        wins: 12,
        era: "3.40",
      },
    },
    ...overrides,
  } as LeanPlayer;
}

describe("assessCatalogProjectionHealth", () => {
  it("reports `ok: false` for an empty catalog", () => {
    const h = assessCatalogProjectionHealth([]);
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("empty_catalog");
    expect(h.sampled).toBe(0);
  });

  it("reports `ok: true` when both batting and pitching projections are varied", () => {
    const players: LeanPlayer[] = [];
    for (let i = 0; i < 50; i++) players.push(makePlayer(i));
    for (let i = 0; i < 50; i++) players.push(pitcher(i));
    const h = assessCatalogProjectionHealth(players);
    expect(h.ok).toBe(true);
    expect(h.sampled).toBe(100);
    expect(h.distinct.batting_hr).toBeGreaterThanOrEqual(5);
    expect(h.distinct.pitching_strikeouts).toBeGreaterThanOrEqual(5);
  });

  it("flags the production failure mode where every projection is empty", () => {
    const players: LeanPlayer[] = [];
    for (let i = 0; i < 200; i++) {
      players.push({
        name: `Empty ${i}`,
        team: "FA",
        position: "OF",
        catalog_rank: i,
        catalog_tier: 5,
        // catalog value still varies (matches what /catalog/batch-values returned in prod)
        value: 100 - (i % 10),
        projection: { batting: {}, pitching: {} },
      } as LeanPlayer);
    }
    const h = assessCatalogProjectionHealth(players);
    expect(h.ok).toBe(false);
    expect(h.reason).toContain("batting_projection_uniform");
    expect(h.reason).toContain("pitching_projection_uniform");
    expect(h.distinct.catalog_value).toBeGreaterThan(1);
  });

  it("flags batting-only collapse even when pitching looks healthy", () => {
    const players: LeanPlayer[] = [];
    for (let i = 0; i < 60; i++) {
      players.push(makePlayer(i, { projection: { batting: {}, pitching: {} } }));
    }
    for (let i = 0; i < 60; i++) players.push(pitcher(i));
    const h = assessCatalogProjectionHealth(players);
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("batting_projection_uniform");
  });

  it("only samples the top N by `value`", () => {
    const players: LeanPlayer[] = [];
    for (let i = 0; i < 25; i++) players.push(makePlayer(i, { value: 100 - i }));
    for (let i = 0; i < 200; i++) {
      players.push(
        makePlayer(i + 25, {
          value: 1,
          projection: { batting: {}, pitching: {} },
        })
      );
    }
    const h = assessCatalogProjectionHealth(players, 25);
    expect(h.sampled).toBe(25);
    expect(h.distinct.batting_hr).toBeGreaterThan(1);
  });
});

describe("isBaselineOutputCollapsed", () => {
  it("returns false for a varied baseline distribution", () => {
    const baselines = Array.from({ length: 100 }, (_, i) => ({
      value: 30 - i * 0.25,
    }));
    expect(isBaselineOutputCollapsed(baselines)).toBe(false);
  });

  it("returns true when every baseline is the same number (production symptom)", () => {
    const baselines = Array.from({ length: 100 }, () => ({ value: 10.35 }));
    expect(isBaselineOutputCollapsed(baselines)).toBe(true);
  });

  it("returns false for tiny pools so single-player calls never trip the alert", () => {
    expect(isBaselineOutputCollapsed([{ value: 5 }])).toBe(false);
  });
});
