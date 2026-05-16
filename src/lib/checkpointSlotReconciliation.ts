import {
  buildRosteredPlayersForSlotEngine,
  isReserveRosterSlotForEngine,
} from "./rosteredPlayersForSlots";
import { leagueSlotCapacity } from "../services/teamAdjustedBudget";
import type { DraftedPlayer, NormalizedValuationInput, RosterSlot } from "../types/brain";

/** Catalog checkpoint id (payload `checkpoint` field). */
export const ENGINE_CHECKPOINT_IDS = [
  "pre_draft",
  "after_pick_10",
  "after_pick_50",
  "after_pick_100",
  "after_pick_130",
  "finished_league",
] as const;

export type EngineCheckpointId = (typeof ENGINE_CHECKPOINT_IDS)[number];

/** AmethystDraft fixture filenames (canonical for curve audit). */
export const DRAFT_CHECKPOINT_FILENAME: Record<EngineCheckpointId, string> = {
  pre_draft: "pre_draft.json",
  after_pick_10: "after_10.json",
  after_pick_50: "after_50.json",
  after_pick_100: "after_100.json",
  after_pick_130: "after_130.json",
  finished_league: "finished_league.json",
};

/** Legacy AmethystAPI flat fixtures — different roster template (22 slots/team, 198 cap). */
export const ENGINE_LEGACY_CHECKPOINT_FILENAME: Record<
  Exclude<EngineCheckpointId, "finished_league">,
  string
> = {
  pre_draft: "pre_draft.json",
  after_pick_10: "after_pick_10.json",
  after_pick_50: "after_pick_50.json",
  after_pick_100: "after_pick_100.json",
  after_pick_130: "after_pick_130.json",
};

export const EXPECTED_DRAFT_STATE_LENGTH: Record<EngineCheckpointId, number> = {
  pre_draft: 0,
  after_pick_10: 10,
  after_pick_50: 50,
  after_pick_100: 100,
  after_pick_130: 130,
  finished_league: 133,
};

function rosterSlotsPerTeamSummary(rosterSlots: RosterSlot[]): {
  slots_per_team: number;
  slot_keys: string[];
  config_summary: string;
} {
  const slot_keys: string[] = [];
  let slots_per_team = 0;
  for (const rs of rosterSlots) {
    const k = rs.position.toUpperCase().trim();
    const c = Math.max(0, Math.floor(rs.count ?? 0));
    if (c > 0) {
      slot_keys.push(k);
      slots_per_team += c;
    }
  }
  return {
    slots_per_team,
    slot_keys,
    config_summary: rosterSlots
      .filter((rs) => (rs.count ?? 0) > 0)
      .map((rs) => `${rs.position}×${rs.count}`)
      .join(", "),
  };
}

function iterPreDraftRows(
  preDraft: NormalizedValuationInput["pre_draft_rosters"]
): Array<Record<string, unknown>> {
  if (!preDraft) return [];
  const out: Array<Record<string, unknown>> = [];
  if (Array.isArray(preDraft)) {
    for (const bucket of preDraft) {
      const players = (bucket as { players?: unknown[] }).players;
      if (Array.isArray(players)) {
        for (const row of players) {
          if (typeof row === "object" && row != null) out.push(row as Record<string, unknown>);
        }
      }
    }
    return out;
  }
  for (const rows of Object.values(preDraft)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (typeof row === "object" && row != null) out.push(row as Record<string, unknown>);
    }
  }
  return out;
}

function countReserveInBuckets(
  buckets: NormalizedValuationInput["minors"] | NormalizedValuationInput["taxi"]
): number {
  if (!buckets) return 0;
  const sections = Array.isArray(buckets) ? buckets : Object.values(buckets);
  let n = 0;
  for (const section of sections) {
    const rows = Array.isArray(section)
      ? section
      : (section as { players?: unknown[] }).players;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (typeof row !== "object" || row == null) continue;
      const rec = row as Record<string, unknown>;
      const slot = typeof rec.roster_slot === "string" ? rec.roster_slot : "";
      if (isReserveRosterSlotForEngine(slot)) n++;
    }
  }
  return n;
}

/**
 * Reconcile active auction slot demand for a normalized checkpoint input.
 * MIN/TAXI are excluded from active slot demand; they may still appear in pool removal.
 */
export function reconcileCheckpointSlotDemand(
  input: NormalizedValuationInput,
  options?: {
    checkpoint_id?: string;
    fixture_path?: string;
    engine_remaining_slots?: number;
  }
): {
  checkpoint_name: string;
  fixture_path: string | null;
  roster_slot_capacity: number;
  roster_slots_per_team: number;
  roster_slot_configuration: string;
  roster_slot_keys: string[];
  num_teams: number;
  draft_state_length: number;
  draft_state_active_rows: number;
  draft_state_active_with_player_id: number;
  draft_state_missing_player_id: number;
  draft_state_duplicate_player_ids: number;
  draft_state_keeper_flags: number;
  pre_draft_roster_rows: number;
  pre_draft_keeper_rows: number;
  pre_draft_keepers_added_to_slot_engine: number;
  active_drafted_auction_count: number;
  active_rostered_slot_engine_count: number;
  active_rostered_keeper_count: number;
  remaining_active_slots_arithmetic: number;
  remaining_active_slots_engine: number | null;
  engine_vs_arithmetic_remaining_delta: number | null;
  remaining_slots_formula_matches_engine: boolean | null;
  active_rostered_equals_keepers_plus_auction_unique: boolean;
  expected_active_rostered_if_no_overlap: number;
  keeper_overlap_with_draft_state: string[];
  keeper_count_drop_from_pre_draft: number;
  min_count_in_minors_taxi_buckets: number;
  min_taxi_excluded_from_active_demand: true;
  over_capacity_rostered: boolean;
  notes: string[];
} {
  const checkpoint_name =
    options?.checkpoint_id ?? input.checkpoint ?? "unknown";
  const slotEngine = buildRosteredPlayersForSlotEngine(input);
  const cap = leagueSlotCapacity(input.roster_slots, input.num_teams);
  const slotSummary = rosterSlotsPerTeamSummary(input.roster_slots);

  const ds = input.drafted_players;
  const dsActive = ds.filter((d) => !isReserveRosterSlotForEngine(d.roster_slot));
  const dsWithPid = dsActive.filter((d) => d.player_id);
  const dsMissingPid = dsActive.length - dsWithPid.length;
  const dsPidSet = new Set(dsWithPid.map((d) => d.player_id));
  const dsDup = dsWithPid.length - dsPidSet.size;
  const dsKeeperFlags = dsActive.filter((d) => d.is_keeper).length;

  const pdrRows = iterPreDraftRows(input.pre_draft_rosters);
  const pdrKeepers = pdrRows.filter((r) => r.is_keeper === true);
  const pdrKeeperIds = pdrKeepers
    .map((r) => r.player_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const keeperOverlap = pdrKeeperIds.filter((id) => dsPidSet.has(id));
  const pdrAdded = pdrKeeperIds.filter((id) => !dsPidSet.has(id)).length;

  const auctionDrafted = dsActive.filter((d) => !d.is_keeper).length;
  const expectedNoOverlap = pdrKeeperIds.length + auctionDrafted;

  const keepersInEngine = slotEngine.filter((p) => p.is_keeper).length;
  const arithmeticRemaining = cap - slotEngine.length;
  const engineRemaining = options?.engine_remaining_slots ?? null;
  const formulaMatches =
    engineRemaining == null ? null : engineRemaining === arithmeticRemaining;

  const minCount =
    countReserveInBuckets(input.minors) + countReserveInBuckets(input.taxi);

  const notes: string[] = [];
  if (keeperOverlap.length > 0) {
    notes.push(
      `${keeperOverlap.length} keeper(s) also appear in draft_state; auction row wins dedupe and may clear is_keeper — slot_engine keeper_count can drop below pre_draft_rosters keeper rows.`
    );
  }
  if (slotEngine.length > cap) {
    notes.push(
      `active_rostered (${slotEngine.length}) exceeds league capacity (${cap}); replacement_slots_v2 remaining_slots floors at 0 after greedy fill — arithmetic remaining (${arithmeticRemaining}) is not used as engine remaining.`
    );
  } else if (
    engineRemaining != null &&
    engineRemaining !== arithmeticRemaining
  ) {
    notes.push(
      `engine remaining_slots (${engineRemaining}) differs from capacity − rostered (${arithmeticRemaining}): v2 counts unfilled slot demand after greedy assignment (position eligibility), not a 1:1 player-to-slot count.`
    );
  }
  if (checkpoint_name === "finished_league") {
    notes.push(
      "finished_league draft_state is the full Draft sheet (133 auction picks), not Final Roster embed; pre_draft_rosters still supplies keepers not duplicated in draft_state."
    );
  }
  const expectedLen = EXPECTED_DRAFT_STATE_LENGTH[checkpoint_name as EngineCheckpointId];
  if (typeof expectedLen === "number" && ds.length !== expectedLen) {
    notes.push(
      `draft_state length ${ds.length} differs from canonical fixture expectation ${expectedLen} for ${checkpoint_name}.`
    );
  }

  return {
    checkpoint_name,
    fixture_path: options?.fixture_path ?? null,
    roster_slot_capacity: cap,
    roster_slots_per_team: slotSummary.slots_per_team,
    roster_slot_configuration: slotSummary.config_summary,
    roster_slot_keys: slotSummary.slot_keys,
    num_teams: input.num_teams,
    draft_state_length: ds.length,
    draft_state_active_rows: dsActive.length,
    draft_state_active_with_player_id: dsWithPid.length,
    draft_state_missing_player_id: dsMissingPid,
    draft_state_duplicate_player_ids: dsDup,
    draft_state_keeper_flags: dsKeeperFlags,
    pre_draft_roster_rows: pdrRows.length,
    pre_draft_keeper_rows: pdrKeeperIds.length,
    pre_draft_keepers_added_to_slot_engine: pdrAdded,
    active_drafted_auction_count: auctionDrafted,
    active_rostered_slot_engine_count: slotEngine.length,
    active_rostered_keeper_count: keepersInEngine,
    remaining_active_slots_arithmetic: arithmeticRemaining,
    remaining_active_slots_engine: engineRemaining,
    engine_vs_arithmetic_remaining_delta:
      engineRemaining == null ? null : engineRemaining - arithmeticRemaining,
    remaining_slots_formula_matches_engine: formulaMatches,
    active_rostered_equals_keepers_plus_auction_unique:
      slotEngine.length === expectedNoOverlap,
    expected_active_rostered_if_no_overlap: expectedNoOverlap,
    keeper_overlap_with_draft_state: keeperOverlap,
    keeper_count_drop_from_pre_draft: Math.max(
      0,
      pdrKeeperIds.length - keepersInEngine
    ),
    min_count_in_minors_taxi_buckets: minCount,
    min_taxi_excluded_from_active_demand: true,
    over_capacity_rostered: slotEngine.length > cap,
    notes,
  };
}

export function summarizeReconciliationLine(r: ReturnType<typeof reconcileCheckpointSlotDemand>): string {
  const eng = r.remaining_active_slots_engine;
  const rem =
    eng != null
      ? `engine_remaining=${eng}`
      : `arithmetic_remaining=${r.remaining_active_slots_arithmetic}`;
  return [
    `${r.checkpoint_name}`,
    `cap=${r.roster_slot_capacity}`,
    `rostered=${r.active_rostered_slot_engine_count}`,
    `keepers=${r.active_rostered_keeper_count}`,
    `draft_active=${r.draft_state_active_with_player_id}`,
    rem,
    r.active_rostered_equals_keepers_plus_auction_unique ? "unique_ok" : "overlap",
  ].join(" | ");
}
