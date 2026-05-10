/**
 * Conservative catalog identity repair plan (dry-run by default).
 *
 *   pnpm repair:catalog-identities          # default: dry-run only
 *   pnpm repair:catalog-identities -- --dry-run
 *
 * Default is always dry-run. --apply is not implemented.
 * Does NOT delete or update Mongo rows in this implementation.
 * Writes tmp/catalog-identity-repair-plan.json
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import Player from "../src/models/Player";
import type { CatalogIdentityRow } from "../src/lib/catalogIdentityHelpers";
import {
  classifyShadowPair,
  countSameNameDistinctMlbIdGroups,
  findDuplicateMlbIdGroups,
  findShadowPairs,
  hasCanonicalMlbId,
  projectionSummary,
  rowUsesObjectIdPlayerId,
  valuationPlayerIdFromRow,
} from "../src/lib/catalogIdentityHelpers";

const ROOT = path.resolve(__dirname, "..");

function toRow(doc: Record<string, unknown>): CatalogIdentityRow {
  return {
    _id: String(doc._id),
    mlbId: doc.mlbId as number | null | undefined,
    name: String(doc.name ?? ""),
    team: String(doc.team ?? ""),
    position: String(doc.position ?? ""),
    positions: Array.isArray(doc.positions) ? (doc.positions as string[]) : undefined,
    adp: typeof doc.adp === "number" ? doc.adp : Number(doc.adp) || 0,
    tier: typeof doc.tier === "number" ? doc.tier : Number(doc.tier) || 0,
    value: typeof doc.value === "number" ? doc.value : Number(doc.value) || 0,
    projection: doc.projection,
  };
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = true;
  for (const a of argv.filter((x) => x !== "--")) {
    if (a === "--dry-run" || a === "--dryRun") dryRun = true;
    if (a === "--apply") dryRun = false;
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  if (!dryRun) {
    console.error("--apply is not implemented; only dry-run plans are emitted.");
    process.exit(2);
  }

  await mongoose.connect(uri);
  let rows: CatalogIdentityRow[];
  try {
    const docs = await Player.find({})
      .select("mlbId name team position positions adp tier value projection")
      .lean();
    rows = (docs as Record<string, unknown>[]).map(toRow);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const shadows = findShadowPairs(rows);
  const proposed: Record<string, unknown>[] = [];
  const conflictReviewPairs: Record<string, unknown>[] = [];
  const manualRoleReviewPairs: Record<string, unknown>[] = [];
  const duplicateMlbIdGroups: Record<string, unknown>[] = [];

  for (const { canonical, shadow, key } of shadows) {
    const tier = classifyShadowPair({ key, canonical, shadow });
    if (tier === "MANUAL_REVIEW_ROLE_MISMATCH") {
      manualRoleReviewPairs.push({
        type: "MANUAL_REVIEW_ROLE_MISMATCH",
        match_key: key,
        reason:
          "Pitcher primary token differs (e.g. P vs RP) while name/team suggest the same player — normalize role codes, then re-run audit before delete.",
        canonical: {
          mongo_id: canonical._id,
          mlbId: canonical.mlbId,
          position: canonical.position,
          projection_summary: projectionSummary(canonical.projection, 220),
        },
        shadow: {
          mongo_id: shadow._id,
          position: shadow.position,
          projection_summary: projectionSummary(shadow.projection, 220),
        },
        recommendation:
          "Manual: choose canonical primary position (P vs RP), merge projection, then dedupe — not an orphan greenfield row.",
      });
      continue;
    }
    if (tier === "CONFLICT_REVIEW") {
      conflictReviewPairs.push({
        type: "CONFLICT_REVIEW",
        match_key: key,
        reason: "Projection fingerprint differs materially between canonical and ObjectId row",
        canonical: {
          mongo_id: canonical._id,
          mlbId: canonical.mlbId,
          projection_summary: projectionSummary(canonical.projection, 220),
        },
        shadow: {
          mongo_id: shadow._id,
          projection_summary: projectionSummary(shadow.projection, 220),
        },
        recommendation: "Manual merge: pick authoritative projection source, then delete or backfill shadow row.",
      });
      continue;
    }
    proposed.push({
      type: "PROPOSE_DELETE_SHADOW_DUPLICATE",
      match_key: key,
      rationale:
        "Strong identity match: ObjectId row without mlbId pairs one unambiguous canonical mlbId row; same name; team- and role-compatible; projections align within tolerance.",
      delete_mongo_id: shadow._id,
      delete_valuation_player_id: valuationPlayerIdFromRow(shadow),
      keep_mongo_id: canonical._id,
      keep_mlbId: canonical.mlbId,
      keep_valuation_player_id: valuationPlayerIdFromRow(canonical),
      shadow_snapshot: {
        name: shadow.name,
        team: shadow.team,
        position: shadow.position,
        adp: shadow.adp,
        tier: shadow.tier,
        value: shadow.value,
        projection_summary: projectionSummary(shadow.projection, 300),
      },
      canonical_snapshot: {
        name: canonical.name,
        team: canonical.team,
        position: canonical.position,
        adp: canonical.adp,
        tier: canonical.tier,
        value: canonical.value,
        projection_summary: projectionSummary(canonical.projection, 300),
      },
    });
  }

  const orphans = rows.filter(
    (r) => !hasCanonicalMlbId(r) && rowUsesObjectIdPlayerId(r) && !shadows.some((s) => s.shadow._id === r._id)
  );

  for (const o of orphans.slice(0, 80)) {
    proposed.push({
      type: "PROPOSE_MANUAL_REVIEW_ORPHAN_NO_MLBID",
      mongo_id: o._id,
      valuation_player_id: valuationPlayerIdFromRow(o),
      name: o.name,
      team: o.team,
      note: "No unambiguous canonical mlbId match for this ObjectId row (same-name clusters are not assumed duplicates). Backfill mlbId, merge manually, or delete if junk.",
    });
  }

  const dupMlbGroups = findDuplicateMlbIdGroups(rows);
  const sameNameDistinctMlbIds = countSameNameDistinctMlbIdGroups(rows);
  for (const [mlbId, arr] of dupMlbGroups) {
    duplicateMlbIdGroups.push({
      type: "DUPLICATE_MLBID",
      mlbId,
      mongo_ids: arr.map((x) => x._id),
      recommendation: "Keep one canonical document per mlbId; merge or delete extras after review.",
    });
  }

  let conflictReviewPairCount = 0;
  let safeExactDuplicatePairCount = 0;
  let manualRoleMismatchPairs = 0;
  for (const s of shadows) {
    const t = classifyShadowPair(s);
    if (t === "CONFLICT_REVIEW") conflictReviewPairCount++;
    else if (t === "MANUAL_REVIEW_ROLE_MISMATCH") manualRoleMismatchPairs++;
    else safeExactDuplicatePairCount++;
  }

  const safeExactDuplicatePlanItems = proposed.filter((p) => p.type === "PROPOSE_DELETE_SHADOW_DUPLICATE");
  const orphanOidReviewPairs = proposed.filter((p) => p.type === "PROPOSE_MANUAL_REVIEW_ORPHAN_NO_MLBID");

  const likelyShadowPairRecords = shadows.map((s) => ({
    match_key: s.key,
    classification: classifyShadowPair(s),
    canonical_mongo_id: s.canonical._id,
    shadow_mongo_id: s.shadow._id,
    canonical_mlbId: s.canonical.mlbId ?? null,
  }));

  const out = {
    generatedAt: new Date().toISOString(),
    dry_run: true,
    policy:
      "Conservative: OID↔mlbId shadow pairs require unambiguous canonical match (name + team rules + role compatibility). Same-name-only groups are not duplicates. Never auto-delete in this script — export plan only.",
    counts: {
      likely_shadow_pairs: shadows.length,
      conflict_review_pairs: conflictReviewPairCount,
      manual_role_review_pairs: manualRoleMismatchPairs,
      safe_exact_duplicate_pairs: safeExactDuplicatePairCount,
      same_name_distinct_mlb_ids: sameNameDistinctMlbIds,
      duplicate_mlb_id_groups: dupMlbGroups.size,
      proposed_operations: proposed.length,
      conflicts_total: conflictReviewPairs.length + duplicateMlbIdGroups.length,
      manual_reviews_total: manualRoleReviewPairs.length,
      orphan_oid_without_shadow_match: orphans.length,
      shadow_pairs: shadows.length,
    },
    likely_shadow_pairs: likelyShadowPairRecords,
    conflict_review_pairs: conflictReviewPairs,
    manual_role_review_pairs: manualRoleReviewPairs,
    duplicate_mlb_id_groups: duplicateMlbIdGroups,
    same_name_distinct_mlb_ids: {
      group_count: sameNameDistinctMlbIds,
      samples_note: "See tmp/catalog-identity-audit.json → same_name_distinct_mlb_ids_samples",
    },
    safe_exact_duplicate_pairs: safeExactDuplicatePlanItems,
    orphan_oid_without_shadow_match: orphanOidReviewPairs,
    proposed_operations: proposed,
    conflicts: [...conflictReviewPairs, ...duplicateMlbIdGroups],
    manual_reviews: manualRoleReviewPairs,
  };

  const abs = path.join(ROOT, "tmp", "catalog-identity-repair-plan.json");
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(out, null, 2));

  console.log(
    JSON.stringify(
      {
        dry_run: true,
        likely_shadow_pairs: shadows.length,
        conflict_review_pairs: conflictReviewPairCount,
        manual_role_review_pairs: manualRoleMismatchPairs,
        safe_exact_duplicate_pairs: safeExactDuplicatePairCount,
        same_name_distinct_mlb_ids: sameNameDistinctMlbIds,
        duplicate_mlb_id_groups: dupMlbGroups.size,
        proposed_operations: proposed.length,
        conflicts_total: conflictReviewPairs.length + duplicateMlbIdGroups.length,
        manual_reviews_total: manualRoleReviewPairs.length,
        orphans_no_match: orphans.length,
        wrote: abs,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
