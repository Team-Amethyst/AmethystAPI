/**
 * Draftable pool vs replacement-depth semantics for valuation responses
 * (`replacement_slots_v2`: `draftable_player_ids`, `draftable_pool_size`).
 *
 * Intended for Draftroom Research and similar UIs — does not change auction math.
 */

/** Tooltip for rows outside the greedy draftable fill at the auction floor. */
export const TOOLTIP_OUTSIDE_DRAFTABLE_MIN_BID =
  "This player is outside the current draftable pool and is priced at the minimum bid.";

export type DraftablePoolMeta =
  | {
      kind: "resolved";
      draftableSet: ReadonlySet<string>;
      draftable_pool_size: number;
    }
  | {
      kind: "unknown";
      reason:
        | "missing_draftable_player_ids"
        | "missing_draftable_pool_size"
        | "length_mismatch"
        | "empty_draftable_set";
    };

function asFiniteNonNegativeInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 0) return null;
  return n;
}

/**
 * Normalize engine `draftable_player_ids` / `draftable_pool_size`.
 * On any inconsistency or absence, returns `unknown` so callers avoid false "depth" labels.
 */
export function normalizeDraftablePoolMeta(response: {
  draftable_player_ids?: unknown;
  draftable_pool_size?: unknown;
}): DraftablePoolMeta {
  const idsRaw = response.draftable_player_ids;
  const dps = asFiniteNonNegativeInt(response.draftable_pool_size);
  if (!Array.isArray(idsRaw)) {
    return { kind: "unknown", reason: "missing_draftable_player_ids" };
  }
  if (dps === null) {
    return { kind: "unknown", reason: "missing_draftable_pool_size" };
  }
  const strIds = idsRaw
    .map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim()))
    .filter((s) => s.length > 0);
  if (strIds.length !== dps) {
    return { kind: "unknown", reason: "length_mismatch" };
  }
  if (strIds.length === 0) {
    return { kind: "unknown", reason: "empty_draftable_set" };
  }
  return { kind: "resolved", draftableSet: new Set(strIds), draftable_pool_size: dps };
}

/**
 * Whether `playerId` is in the draftable greedy-fill set.
 * `null` = metadata missing or invalid — do not show draftable vs depth assertions.
 */
export function isPlayerInDraftablePool(meta: DraftablePoolMeta, playerId: string): boolean | null {
  if (meta.kind !== "resolved") return null;
  return meta.draftableSet.has(playerId);
}

/** Matches calibration “near min” band for auction dollars. */
export function isNearMinimumAuctionBid(auctionValue: unknown): boolean {
  const n = typeof auctionValue === "number" ? auctionValue : Number(auctionValue);
  if (!Number.isFinite(n)) return false;
  return n <= 1.05;
}

/**
 * Eligible for the Research-style explainer: known outside draftable + dollars at/near floor.
 */
export function shouldShowOutsideDraftableMinBidTooltip(input: {
  meta: DraftablePoolMeta;
  playerId: string;
  auctionValue: unknown;
}): boolean {
  if (input.meta.kind !== "resolved") return false;
  if (input.meta.draftableSet.has(input.playerId)) return false;
  return isNearMinimumAuctionBid(input.auctionValue);
}
