import { readFileSync } from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import {
  DRAFT_CHECKPOINT_FILENAME,
  ENGINE_CHECKPOINT_IDS,
  EXPECTED_DRAFT_STATE_LENGTH,
  reconcileCheckpointSlotDemand,
} from "../src/lib/checkpointSlotReconciliation";
import { leagueSlotCapacity } from "../src/services/teamAdjustedBudget";

const DRAFT_FIXTURES_DIR = path.resolve(
  __dirname,
  "../../AmethystDraft/apps/api/test-fixtures/player-api/checkpoints"
);

function loadDraftCheckpoint(id: (typeof ENGINE_CHECKPOINT_IDS)[number]) {
  const file = DRAFT_CHECKPOINT_FILENAME[id];
  const raw = JSON.parse(
    readFileSync(path.join(DRAFT_FIXTURES_DIR, file), "utf8")
  );
  return buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
}

describe("checkpoint slot reconciliation (AmethystDraft fixtures)", () => {
  it.each([...ENGINE_CHECKPOINT_IDS])("%s draft_state length matches catalog", (id) => {
      const input = loadDraftCheckpoint(id);
      expect(input.drafted_players).toHaveLength(EXPECTED_DRAFT_STATE_LENGTH[id]);
    }
  );

  it("pre_draft anchor: 189 capacity, 76 keepers, 113 remaining", () => {
    const input = loadDraftCheckpoint("pre_draft");
    const r = reconcileCheckpointSlotDemand(input, { checkpoint_id: "pre_draft" });
    expect(r.roster_slot_capacity).toBe(189);
    expect(r.num_teams).toBe(9);
    expect(r.active_rostered_slot_engine_count).toBe(76);
    expect(r.active_rostered_keeper_count).toBe(76);
    expect(r.remaining_active_slots_arithmetic).toBe(113);
    expect(r.active_rostered_equals_keepers_plus_auction_unique).toBe(true);
    expect(r.min_taxi_excluded_from_active_demand).toBe(true);
  });

  it("after_pick_10: 86 rostered, 103 remaining at capacity 189", () => {
    const input = loadDraftCheckpoint("after_pick_10");
    const r = reconcileCheckpointSlotDemand(input, { checkpoint_id: "after_pick_10" });
    expect(r.roster_slot_capacity).toBe(189);
    expect(r.active_rostered_slot_engine_count).toBe(86);
    expect(r.remaining_active_slots_arithmetic).toBe(103);
    expect(r.active_drafted_auction_count).toBe(10);
    expect(r.pre_draft_keeper_rows).toBe(76);
    expect(r.active_rostered_equals_keepers_plus_auction_unique).toBe(true);
  });

  it("after_pick_50/100: keeper overlap reduces unique keeper count", () => {
    const r50 = reconcileCheckpointSlotDemand(loadDraftCheckpoint("after_pick_50"), {
      checkpoint_id: "after_pick_50",
    });
    expect(r50.roster_slot_capacity).toBe(189);
    expect(r50.active_rostered_slot_engine_count).toBe(125);
    expect(r50.remaining_active_slots_arithmetic).toBe(64);
    expect(r50.keeper_overlap_with_draft_state.length).toBe(1);
    expect(r50.active_rostered_keeper_count).toBe(75);

    const r100 = reconcileCheckpointSlotDemand(loadDraftCheckpoint("after_pick_100"), {
      checkpoint_id: "after_pick_100",
    });
    expect(r100.active_rostered_slot_engine_count).toBe(175);
    expect(r100.remaining_active_slots_arithmetic).toBe(14);
    expect(r100.keeper_overlap_with_draft_state.length).toBe(1);
  });

  it("after_pick_130 and finished_league can exceed capacity (arithmetic remaining negative)", () => {
    const r130 = reconcileCheckpointSlotDemand(loadDraftCheckpoint("after_pick_130"), {
      checkpoint_id: "after_pick_130",
    });
    expect(r130.active_rostered_slot_engine_count).toBe(204);
    expect(r130.remaining_active_slots_arithmetic).toBe(-15);
    expect(r130.over_capacity_rostered).toBe(true);
    expect(r130.keeper_overlap_with_draft_state.length).toBe(2);
    expect(r130.active_rostered_keeper_count).toBe(74);

    const finished = reconcileCheckpointSlotDemand(
      loadDraftCheckpoint("finished_league"),
      { checkpoint_id: "finished_league" }
    );
    expect(finished.draft_state_length).toBe(133);
    expect(finished.active_rostered_slot_engine_count).toBe(207);
    expect(finished.remaining_active_slots_arithmetic).toBe(-18);
    expect(finished.keeper_overlap_with_draft_state.length).toBe(2);
  });

  it("legacy AmethystAPI after_pick_10 flat fixture has 198 capacity (not used by curve audit)", () => {
    const legacyPath = path.resolve(
      __dirname,
      "../test-fixtures/player-api/checkpoints/after_pick_10.json"
    );
    const raw = JSON.parse(readFileSync(legacyPath, "utf8"));
    expect(raw.roster_slots).toBeDefined();
    expect(Array.isArray(raw.roster_slots)).toBe(true);
    const slotsPerTeam = raw.roster_slots.reduce(
      (s: number, x: { count?: number }) => s + (x.count ?? 0),
      0
    );
    expect(slotsPerTeam).toBe(22);
    expect(slotsPerTeam * raw.num_teams).toBe(198);
    expect(leagueSlotCapacity(raw.roster_slots, raw.num_teams)).toBe(198);
  });
});
