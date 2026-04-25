import type { DraftedPlayer, NormalizedValuationInput } from "../types/brain";

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
  return {
    player_id,
    name: typeof rec.name === "string" ? rec.name : "",
    position,
    ...(positions && positions.length > 0 ? { positions } : {}),
    team: typeof rec.team === "string" ? rec.team : "",
    team_id: typeof rec.team_id === "string" ? rec.team_id : "",
    paid: typeof rec.paid === "number" ? rec.paid : undefined,
  };
}

function collectRows(rows: unknown[] | undefined, out: DraftedPlayer[]) {
  for (const row of rows ?? []) {
    if (typeof row !== "object" || row == null) continue;
    const dp = rowToDrafted(row as Record<string, unknown>);
    if (dp) out.push(dp);
  }
}

/**
 * All players consuming roster slots (auction picks + keepers + minors + taxi),
 * deduped by `player_id` with auction rows winning over keeper duplicates.
 */
export function buildRosteredPlayersForSlotEngine(
  input: NormalizedValuationInput
): DraftedPlayer[] {
  const byId = new Map<string, DraftedPlayer>();
  for (const d of input.drafted_players) {
    byId.set(d.player_id, d);
  }
  const pushUnique = (dp: DraftedPlayer) => {
    if (!byId.has(dp.player_id)) byId.set(dp.player_id, dp);
  };

  if (input.pre_draft_rosters) {
    for (const rows of Object.values(input.pre_draft_rosters)) {
      const arr: DraftedPlayer[] = [];
      collectRows(Array.isArray(rows) ? rows : [], arr);
      for (const dp of arr) pushUnique(dp);
    }
  }

  const collectBuckets = (
    buckets: NormalizedValuationInput["minors"] | NormalizedValuationInput["taxi"]
  ) => {
    if (!buckets) return;
    if (Array.isArray(buckets)) {
      for (const b of buckets) {
        const tmp: DraftedPlayer[] = [];
        collectRows(b.players as unknown[], tmp);
        for (const dp of tmp) pushUnique(dp);
      }
      return;
    }
    for (const v of Object.values(buckets)) {
      if (Array.isArray(v)) {
        const tmp: DraftedPlayer[] = [];
        collectRows(v, tmp);
        for (const dp of tmp) pushUnique(dp);
      }
    }
  };

  collectBuckets(input.minors);
  collectBuckets(input.taxi);

  return [...byId.values()];
}
