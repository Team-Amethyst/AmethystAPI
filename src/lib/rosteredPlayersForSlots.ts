import type { DraftedPlayer, NormalizedValuationInput } from "../types/brain";

/** Minors / taxi reserve pools — must not consume active auction slot demand in v2. */
export function isReserveRosterSlotForEngine(
  rosterSlot: string | undefined | null
): boolean {
  const slot = (rosterSlot ?? "").toUpperCase();
  return slot.includes("MIN") || slot.includes("TAXI");
}

function rowToDrafted(rec: Record<string, unknown>): DraftedPlayer | null {
  const player_id = rec.player_id;
  if (typeof player_id !== "string" || player_id.length === 0) return null;
  const position =
    typeof rec.position === "string" && rec.position.length > 0
      ? rec.position
      : "BN";
  const positions = Array.isArray(rec.positions)
    ? (rec.positions as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  const out: DraftedPlayer = {
    player_id,
    name: typeof rec.name === "string" ? rec.name : "",
    position,
    ...(positions && positions.length > 0 ? { positions } : {}),
    team: typeof rec.team === "string" ? rec.team : "",
    team_id: typeof rec.team_id === "string" ? rec.team_id : "",
    paid: typeof rec.paid === "number" ? rec.paid : undefined,
  };
  if (typeof rec.roster_slot === "string" && rec.roster_slot.length > 0) {
    out.roster_slot = rec.roster_slot;
  }
  if (rec.is_keeper === true) out.is_keeper = true;
  return out;
}

function collectRows(rows: unknown[] | undefined, out: DraftedPlayer[]) {
  for (const row of rows ?? []) {
    if (typeof row !== "object" || row == null) continue;
    const dp = rowToDrafted(row as Record<string, unknown>);
    if (dp) out.push(dp);
  }
}

/**
 * Players consuming **active auction** roster slots (auction picks + keepers only).
 * Minors/taxi are excluded here but still removed from the undrafted pool via
 * `additionalDraftedIds` in `extractDraftedIdsAndSpend`.
 *
 * Deduped by `player_id` with auction rows winning over keeper duplicates.
 */
export function buildRosteredPlayersForSlotEngine(
  input: NormalizedValuationInput
): DraftedPlayer[] {
  const byId = new Map<string, DraftedPlayer>();
  for (const d of input.drafted_players) {
    if (isReserveRosterSlotForEngine(d.roster_slot)) continue;
    byId.set(d.player_id, d);
  }
  const pushUnique = (dp: DraftedPlayer) => {
    if (isReserveRosterSlotForEngine(dp.roster_slot)) return;
    if (!byId.has(dp.player_id)) byId.set(dp.player_id, dp);
  };

  if (input.pre_draft_rosters) {
    for (const rows of Object.values(input.pre_draft_rosters)) {
      const arr: DraftedPlayer[] = [];
      collectRows(Array.isArray(rows) ? rows : [], arr);
      for (const dp of arr) pushUnique(dp);
    }
  }

  return [...byId.values()];
}
