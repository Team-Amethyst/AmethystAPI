/**
 * Post-sync catalog quality gates — used by sync-players and tests.
 */

import {
  findDuplicateMlbIdGroups,
  findShadowPairs,
  hasCanonicalMlbId,
  type CatalogIdentityRow,
} from "./catalogIdentityHelpers";
import {
  classifyLeanPlayer,
  nonCustomObjectIdValuationId,
  type CatalogKind,
} from "./catalogRowClassification";
import { getPlayerId } from "./playerId";
import type { LeanPlayer } from "../types/brain";

export type SyncGateResult = {
  errors: string[];
  warnings: string[];
};

function leanToIdentityRow(p: LeanPlayer & { catalogKind?: CatalogKind }): CatalogIdentityRow {
  return {
    _id: String(p._id),
    mlbId: p.mlbId,
    name: p.name,
    team: p.team,
    position: p.position,
    positions: p.positions,
    catalog_rank: p.catalog_rank ?? 0,
    catalog_tier: p.catalog_tier ?? 0,
    value: p.value ?? 0,
    projection: p.projection,
  };
}

/** Catalog rows as stored (includes invalid); used for shadow/dup checks. */
export function runSyncQualityGates(
  allRowsForAudit: CatalogIdentityRow[],
  valuationEligibleLean: LeanPlayer[],
  options?: {
    /** Players with tier <= this must have projection batting or pitching. */
    topTierProjectionCutoff?: number;
  }
): SyncGateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const cutoff = options?.topTierProjectionCutoff ?? 3;

  for (const p of valuationEligibleLean) {
    const cls = classifyLeanPlayer(p);
    if (cls === "invalid_catalog_row") {
      errors.push(`valuation row classified invalid (should not reach pool): ${getPlayerId(p)} (${p.name})`);
    }
    if (cls !== "custom_player" && !hasCanonicalMlbId(leanToIdentityRow(p))) {
      errors.push(
        `valuation row ${getPlayerId(p)} (${p.name}): non-custom row lacks mlbId`
      );
    }
    if (nonCustomObjectIdValuationId(p)) {
      errors.push(
        `valuation row uses ObjectId player_id but is not catalogKind=custom: ${getPlayerId(p)} (${p.name})`
      );
    }
    const proj = p.projection;
    const hasProj =
      proj != null &&
      typeof proj === "object" &&
      ("batting" in (proj as object) || "pitching" in (proj as object));
    if ((p.catalog_tier ?? 99) <= cutoff && p.value > 0 && !hasProj) {
      errors.push(
        `top-tier player missing projection object: mlbId=${p.mlbId ?? "none"} ${p.name} catalog_tier=${p.catalog_tier}`
      );
    }
    const teamU = (p.team ?? "").trim().toUpperCase();
    if (
      process.env.AMETHYST_SKIP_MLB_TEAM_HYDRATE !== "1" &&
      hasCanonicalMlbId(leanToIdentityRow(p)) &&
      cls !== "custom_player" &&
      teamU === "--" &&
      (p.catalog_tier ?? 99) <= 3 &&
      (p.value ?? 0) > 0
    ) {
      warnings.push(
        `placeholder team "--" after hydration (may be FA/off-season API gap): ${p.name} (mlbId=${p.mlbId})`
      );
    }
  }

  const dupGroups = findDuplicateMlbIdGroups(allRowsForAudit);
  if (dupGroups.size > 0) {
    errors.push(`duplicate mlbId groups: ${dupGroups.size}`);
  }

  const shadows = findShadowPairs(allRowsForAudit);
  if (shadows.length > 0) {
    errors.push(`likely shadow pairs remain: ${shadows.length}`);
  }

  return { errors, warnings };
}

export function sameNameDistinctMlbIdWarning(rows: CatalogIdentityRow[]): string[] {
  const byName = new Map<string, CatalogIdentityRow[]>();
  for (const r of rows) {
    const k = r.name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/\./g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(r);
  }
  const w: string[] = [];
  for (const [, arr] of byName) {
    if (arr.length < 2) continue;
    const ids = new Set(
      arr.filter(hasCanonicalMlbId).map((x) => Number(x.mlbId))
    );
    if (ids.size >= 2) {
      w.push(`same normalized name with ${ids.size} distinct mlbIds: ${arr[0]?.name ?? ""}`);
    }
  }
  return w.slice(0, 50);
}
