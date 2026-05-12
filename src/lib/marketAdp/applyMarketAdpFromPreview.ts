import type { ProposedCatalogUpdate } from "./types";

/** Mongo fields allowed on $set for market ADP ingest (never catalog / valuation fields). */
export const MARKET_ADP_APPLY_FIELD_KEYS = [
  "market_adp",
  "market_adp_source",
  "market_adp_updated_at",
  "market_adp_min",
  "market_adp_max",
  "market_pick_count",
] as const;

export type MarketAdpApplyFieldKey = (typeof MARKET_ADP_APPLY_FIELD_KEYS)[number];

export type MarketAdpPreviewLike = {
  proposed_updates?: ProposedCatalogUpdate[];
  matches?: Array<{ kind?: string }>;
  catalog_unmatched_report?: unknown[];
  adapter_display_name?: string;
};

export function isStrictlyNumericMlbPlayerId(playerId: string): boolean {
  if (typeof playerId !== "string" || playerId.length === 0) return false;
  return /^[1-9]\d*$/.test(playerId);
}

function isPositiveIntMlbId(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/**
 * Restricts a proposed `set` object to Mongo market ADP columns only.
 * Drops `market_adp_match_confidence` and any other non-allowlisted keys.
 */
export function sanitizeMarketAdpMongoSet(
  raw: Record<string, unknown>
): Partial<Record<MarketAdpApplyFieldKey, unknown>> {
  const out: Partial<Record<MarketAdpApplyFieldKey, unknown>> = {};
  for (const k of MARKET_ADP_APPLY_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) {
      const v = raw[k];
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

export function assertMarketAdpApplyPermitted(opts: {
  apply: boolean;
  env: NodeJS.ProcessEnv;
}): void {
  if (!opts.apply) return;
  if (opts.env.MARKET_ADP_APPLY_CONFIRM !== "YES") {
    throw new Error(
      "Refusing apply: pass --apply only with MARKET_ADP_APPLY_CONFIRM=YES in the environment"
    );
  }
}

export type MarketAdpMongoApplyOperation = {
  mlbId: number;
  $set: Record<string, unknown>;
  match_confidence?: string;
};

export type MarketAdpApplyPlanStats = {
  proposed_total: number;
  updates_to_apply: number;
  skipped_invalid_player_id: number;
  skipped_invalid_mlb_id: number;
  skipped_mlb_id_player_id_mismatch: number;
  skipped_missing_market_adp: number;
  skipped_missing_market_adp_source: number;
  /** Proposals where `set` contained keys outside the allowlisted market ADP fields (stripped). */
  proposals_with_non_market_fields_stripped: number;
};

export type MarketAdpApplyPlanResult = {
  operations: MarketAdpMongoApplyOperation[];
  stats: MarketAdpApplyPlanStats;
  ambiguous_vendor_rows_in_preview: number;
  unmatched_vendor_rows_in_preview: number;
  unmatched_catalog_rows_in_preview: number;
};

export function assertPreviewSafeForMarketAdpApply(plan: MarketAdpApplyPlanResult): void {
  if (plan.ambiguous_vendor_rows_in_preview > 0) {
    throw new Error("Refusing apply: preview contains ambiguous vendor matches");
  }
}

/** Single tally for operators (excludes non-market field stripping, which is normalization only). */
export function aggregateRowsSkippedInvalid(stats: MarketAdpApplyPlanStats): number {
  return (
    stats.skipped_invalid_player_id +
    stats.skipped_invalid_mlb_id +
    stats.skipped_mlb_id_player_id_mismatch +
    stats.skipped_missing_market_adp +
    stats.skipped_missing_market_adp_source
  );
}

function countMatchKinds(preview: MarketAdpPreviewLike, kind: string): number {
  const m = preview.matches;
  if (!Array.isArray(m)) return 0;
  let n = 0;
  for (const row of m) {
    if (row && typeof row === "object" && row.kind === kind) n++;
  }
  return n;
}

/**
 * Build Mongo update operations from a `market-adp-ingest-preview` JSON payload.
 * - Skips non-numeric `player_id` (ObjectId-only / invalid).
 * - Skips missing or inconsistent `mlb_id` vs `player_id`.
 * - Never includes ambiguous rows (they are not present in `proposed_updates`; count is diagnostic only).
 * - $set payload is allowlisted market ADP fields only.
 */
export function buildMarketAdpApplyPlanFromPreview(
  preview: MarketAdpPreviewLike
): MarketAdpApplyPlanResult {
  const stats: MarketAdpApplyPlanStats = {
    proposed_total: 0,
    updates_to_apply: 0,
    skipped_invalid_player_id: 0,
    skipped_invalid_mlb_id: 0,
    skipped_mlb_id_player_id_mismatch: 0,
    skipped_missing_market_adp: 0,
    skipped_missing_market_adp_source: 0,
    proposals_with_non_market_fields_stripped: 0,
  };

  const ambiguous_vendor_rows_in_preview = countMatchKinds(preview, "ambiguous");
  const unmatched_vendor_rows_in_preview = countMatchKinds(preview, "unmatched_vendor");
  const unmatched_catalog_rows_in_preview = Array.isArray(preview.catalog_unmatched_report)
    ? preview.catalog_unmatched_report.length
    : 0;

  const proposed = preview.proposed_updates ?? [];
  stats.proposed_total = proposed.length;

  const operations: MarketAdpMongoApplyOperation[] = [];

  for (const pu of proposed) {
    const pid = String(pu.player_id ?? "");
    if (!isStrictlyNumericMlbPlayerId(pid)) {
      stats.skipped_invalid_player_id++;
      continue;
    }
    const pidNum = Number(pid);
    if (!isPositiveIntMlbId(pu.mlb_id)) {
      stats.skipped_invalid_mlb_id++;
      continue;
    }
    if (pu.mlb_id !== pidNum) {
      stats.skipped_mlb_id_player_id_mismatch++;
      continue;
    }

    const rawSet = (pu.set ?? {}) as Record<string, unknown>;
    const nonMarketKeys = Object.keys(rawSet).filter(
      (k) => !(MARKET_ADP_APPLY_FIELD_KEYS as readonly string[]).includes(k)
    );
    if (nonMarketKeys.length > 0) stats.proposals_with_non_market_fields_stripped++;

    const sanitized = sanitizeMarketAdpMongoSet(rawSet);
    if (sanitized.market_adp === undefined) {
      stats.skipped_missing_market_adp++;
      continue;
    }
    if (sanitized.market_adp_source === undefined) {
      stats.skipped_missing_market_adp_source++;
      continue;
    }

    operations.push({
      mlbId: pu.mlb_id,
      $set: sanitized as Record<string, unknown>,
      match_confidence: pu.match_confidence,
    });
    stats.updates_to_apply++;
  }

  return {
    operations,
    stats,
    ambiguous_vendor_rows_in_preview,
    unmatched_vendor_rows_in_preview,
    unmatched_catalog_rows_in_preview,
  };
}
