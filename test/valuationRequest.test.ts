import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { calculateInflation } from "../src/services/inflationEngine";
import type { LeanPlayer } from "../src/types/brain";

const fixturesDir = path.join(__dirname, "../test-fixtures/player-api");
const checkpointsDir = path.join(fixturesDir, "checkpoints");

const mockPlayers: LeanPlayer[] = [
  {
    _id: "x",
    mlbId: 1,
    name: "Alpha",
    team: "NYY",
    position: "OF",
    adp: 5,
    tier: 1,
    value: 40,
  },
  {
    _id: "y",
    mlbId: 2,
    name: "Beta",
    team: "BOS",
    position: "SP",
    adp: 50,
    tier: 3,
    value: 12,
  },
];

describe("parseValuationRequest + root fixtures", () => {
  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !f.startsWith("."));

  it.each(files)("normalizes %s", (file) => {
    const raw = JSON.parse(
      readFileSync(path.join(fixturesDir, file), "utf8")
    ) as unknown;
    const r = parseValuationRequest(raw);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.normalized).toMatchSnapshot();
  });
});

describe("parseValuationRequest + Draft checkpoint fixtures", () => {
  it.each(
    existsSync(checkpointsDir)
      ? readdirSync(checkpointsDir).filter((f) => f.endsWith(".json"))
      : []
  )("parses checkpoint %s", (file) => {
    const raw = JSON.parse(
      readFileSync(path.join(checkpointsDir, file), "utf8")
    ) as unknown;
    const r = parseValuationRequest(raw);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.normalized.schemaVersion).toBe("1.0.0");
    expect(r.normalized.checkpoint).toBeDefined();
    if (file === "pre_draft.json") {
      expect(r.normalized.drafted_players).toHaveLength(0);
    }
    if (file === "after_pick_10.json") {
      expect(r.normalized.drafted_players).toHaveLength(10);
    }
  });

  it("accepts schema_version (snake_case) from Draft", () => {
    const r = parseValuationRequest({
      schema_version: "1.0.0",
      roster_slots: [{ position: "OF", count: 3 }],
      scoring_categories: [{ name: "HR", type: "batting" }],
      total_budget: 260,
      num_teams: 12,
      league_scope: "Mixed",
      drafted_players: [],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.normalized.schemaVersion).toBe("1.0.0");
  });
});

describe("parseValuationRequest errors", () => {
  it("rejects unsupported schema major", () => {
    const r = parseValuationRequest({
      schemaVersion: "2.0.0",
      checkpoint: "x",
      league: {
        roster_slots: [{ position: "C", count: 1 }],
        scoring_categories: [{ name: "HR", type: "batting" }],
        total_budget: 100,
      },
      draft_state: [],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errors.some((e) => e.field === "schema_version")).toBe(true);
  });

  it("returns structured errors with field + message", () => {
    const r = parseValuationRequest({ roster_slots: [] });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toHaveProperty("field");
    expect(r.errors[0]).toHaveProperty("message");
  });
});

describe("calculateInflation with normalized fixtures", () => {
  it("legacy-empty deterministic snapshot", () => {
    const raw = JSON.parse(
      readFileSync(path.join(fixturesDir, "legacy-empty.json"), "utf8")
    );
    const parsed = parseValuationRequest(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const n = parsed.normalized;
    const result = calculateInflation(
      mockPlayers,
      n.drafted_players,
      n.total_budget,
      n.num_teams,
      n.roster_slots,
      n.league_scope,
      {
        deterministic: true,
        seed: n.seed,
        playerIdsFilter: n.player_ids,
        budgetByTeamId: n.budget_by_team_id,
      }
    );
    expect(result).toMatchSnapshot();
  });

  it("nested-after-pick applies player_ids filter", () => {
    const raw = JSON.parse(
      readFileSync(path.join(fixturesDir, "nested-after-pick.json"), "utf8")
    );
    const parsed = parseValuationRequest(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const n = parsed.normalized;
    const result = calculateInflation(
      mockPlayers,
      n.drafted_players,
      n.total_budget,
      n.num_teams,
      n.roster_slots,
      n.league_scope,
      {
        deterministic: true,
        seed: n.seed,
        playerIdsFilter: n.player_ids,
        budgetByTeamId: n.budget_by_team_id,
      }
    );
    expect(result.valuations).toHaveLength(1);
    expect(result.valuations[0].player_id).toBe("2");
    expect(result).toMatchSnapshot();
  });
});
