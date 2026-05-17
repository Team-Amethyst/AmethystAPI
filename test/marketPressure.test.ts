import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import type { LeanPlayer } from "../src/types/brain";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import {
  BUDGET_PRESSURE_TIGHT_CASH_TO_MASS,
  buildMarketPressureSnapshot,
  KEEPER_FILL_MODERATE,
  MARKET_INFLATION_HIGH_CONFIDENCE_MIN,
} from "../src/lib/marketPressure";
import {
  draftCheckpointFixturesAvailable,
  ENGINE_CHECKPOINT_IDS,
  resolveDraftCheckpointFixturePath,
} from "../src/lib/checkpointSlotReconciliation";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
function collectFixturePlayerIds(body: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const addRows = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row != null && typeof row === "object" && "player_id" in row) {
        const pid = (row as { player_id?: unknown }).player_id;
        if (typeof pid === "string" && pid.length > 0) ids.add(pid);
      }
    }
  };
  addRows(body.draft_state);
  const pdr = body.pre_draft_rosters;
  if (Array.isArray(pdr)) {
    for (const bucket of pdr) {
      if (bucket != null && typeof bucket === "object" && "players" in bucket) {
        addRows((bucket as { players?: unknown }).players);
      }
    }
  } else if (pdr && typeof pdr === "object") {
    for (const rows of Object.values(pdr as Record<string, unknown>)) {
      addRows(rows);
    }
  }
  return ids;
}

function mockCatalogForIds(ids: Iterable<string>): LeanPlayer[] {
  let i = 0;
  return [...ids].map((id) => {
    i += 1;
    const mlbId = Number(id);
    return {
      _id: `db_${id}`,
      ...(Number.isFinite(mlbId) ? { mlbId } : {}),
      name: `Player_${id}`,
      team: "NYY",
      position: i % 5 === 0 ? "SP" : "OF",
      catalog_rank: i,
      catalog_tier: (i % 5) + 1,
      value: Math.max(1, 95 - (i % 50)),
    };
  });
}

function loadCheckpoint(id: (typeof ENGINE_CHECKPOINT_IDS)[number]) {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath(id), "utf8")
  ) as Record<string, unknown>;
  return buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
}

describe("buildMarketPressureSnapshot (unit)", () => {
  it("fresh no-keeper: inflation not_started, keeper none", () => {
    const mp = buildMarketPressureSnapshot({
      response: {
        engine_contract_version: "1",
        inflation_model: "replacement_slots_v2",
        inflation_factor: 1,
        inflation_raw: 1,
        inflation_bounded_by: "none",
        total_budget_remaining: 3120,
        pool_value_remaining: 5000,
        players_remaining: 400,
        valuations: [],
        calculated_at: "1970-01-01T00:00:00.000Z",
        remaining_slots: 120,
        min_bid: 1,
        surplus_cash: 3000,
        total_surplus_mass: 8000,
        inflation_index_vs_opening_auction: 1,
      },
      input: {
        schemaVersion: "1.0.0",
        roster_slots: [{ position: "OF", count: 5 }],
        scoring_categories: [{ name: "HR", type: "batting" }],
        total_budget: 260,
        num_teams: 12,
        league_scope: "Mixed",
        drafted_players: [],
        deterministic: true,
      },
      allPlayers: [],
    });
    expect(mp.market_inflation.status).toBe("not_started");
    expect(mp.market_inflation.sample_size).toBe(0);
    expect(mp.keeper_compression.status).toBe("none");
    expect(mp.budget_pressure).toBeDefined();
    expect(mp.allocator_vs_open.label).toBe("Allocator vs Open");
  });
});

describe.skipIf(!draftCheckpointFixturesAvailable())(
  "market_pressure checkpoints (Draft fixtures)",
  () => {
    function runCheckpoint(id: (typeof ENGINE_CHECKPOINT_IDS)[number]) {
      const input = loadCheckpoint(id);
      const ids = collectFixturePlayerIds(
        JSON.parse(
          readFileSync(resolveDraftCheckpointFixturePath(id), "utf8")
        ) as Record<string, unknown>
      );
      const players = mockCatalogForIds(ids);
      const out = executeValuationWorkflow(players, {
        ...input,
        deterministic: true,
        seed: 42,
        inflation_model: "replacement_slots_v2",
      });
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error(out.issues.join("; "));
      return out.response.context_v2?.market_pressure;
    }

    it("pre_draft keeper: not_started inflation, high compression, tight budget", () => {
      const preInput = loadCheckpoint("pre_draft");
      const preIds = collectFixturePlayerIds(
        JSON.parse(
          readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8")
        ) as Record<string, unknown>
      );
      const catalog = mockCatalogForIds(preIds);
      const out = executeValuationWorkflow(catalog, {
        ...preInput,
        deterministic: true,
        seed: 42,
        inflation_model: "replacement_slots_v2",
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const mp =
        out.response.context_v2?.market_pressure ??
        buildMarketPressureSnapshot({
          response: out.response,
          input: preInput,
          allPlayers: catalog,
        });

      expect(mp.market_inflation.status).toBe("not_started");
      expect(mp.market_inflation.sample_size).toBe(0);
      expect(mp.keeper_compression.status).toBe("high");
      expect(mp.keeper_compression.active_keeper_count).toBe(76);
      expect(mp.keeper_compression.active_capacity).toBe(189);
      expect(mp.keeper_compression.keeper_slot_fill_ratio).toBeCloseTo(76 / 189, 2);
      expect(mp.budget_pressure.total_budget_remaining).toBeGreaterThan(1300);
      expect(mp.budget_pressure.total_budget_remaining).toBeLessThan(1550);
      expect(mp.budget_pressure.remaining_active_slots).toBe(113);
      expect(mp.budget_pressure.status).toBe("tight");
      if (mp.allocator_vs_open.ratio != null) {
        expect(mp.allocator_vs_open.ratio).toBeGreaterThan(0.95);
        expect(mp.allocator_vs_open.ratio).toBeLessThan(1.05);
      }
    });

    it.each([
      "after_pick_10",
      "after_pick_50",
      "after_pick_100",
      "after_pick_130",
      "finished_league",
    ] as const)("%s: market pressure present and sane", (id) => {
      const mp = runCheckpoint(id);
      expect(mp).toBeDefined();
      expect(mp!.market_inflation.sample_size).toBeGreaterThanOrEqual(0);
      if (id === "after_pick_10") {
        expect(mp!.market_inflation.sample_size).toBe(10);
        expect(mp!.market_inflation.actual_spend).toBeGreaterThan(0);
        expect(mp!.market_inflation.expected_spend).toBeGreaterThan(0);
        expect(mp!.market_inflation.status).toBe("low_sample");
        expect(["low", "medium"]).toContain(mp!.market_inflation.confidence);
      }
      if (id === "after_pick_50") {
        expect(mp!.market_inflation.sample_size).toBe(50);
        expect(mp!.market_inflation.confidence).toBe("high");
        expect(["inflated", "neutral", "deflated"]).toContain(
          mp!.market_inflation.status,
        );
      }
      if (id === "after_pick_100" || id === "after_pick_130" || id === "finished_league") {
        expect(mp!.market_inflation.sample_size).toBeGreaterThan(0);
        expect(mp!.budget_pressure.remaining_active_slots).toBeGreaterThanOrEqual(0);
      }
    });
  }
);

describe("market pressure thresholds (exported constants)", () => {
  it("documents tight budget and high keeper bands", () => {
    expect(BUDGET_PRESSURE_TIGHT_CASH_TO_MASS).toBe(0.35);
    expect(KEEPER_FILL_MODERATE).toBe(0.4);
    expect(MARKET_INFLATION_HIGH_CONFIDENCE_MIN).toBe(50);
  });
});
