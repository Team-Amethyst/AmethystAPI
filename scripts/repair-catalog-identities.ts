/**
 * Conservative catalog identity repair plan (dry-run by default).
 *
 *   pnpm repair:catalog-identities
 *   pnpm repair:catalog-identities -- --dry-run
 *
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
  findShadowPairs,
  fingerprintConflict,
  hasCanonicalMlbId,
  projectionFingerprint,
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
  const conflicts: Record<string, unknown>[] = [];

  for (const { canonical, shadow, key } of shadows) {
    const fc = projectionFingerprint(canonical.projection);
    const fs = projectionFingerprint(shadow.projection);
    const conflict = fingerprintConflict(fc, fs);
    if (conflict) {
      conflicts.push({
        type: "CONFLICT_REVIEW",
        match_key: key,
        reason: "Projection fingerprint differs materially between canonical and ObjectId row",
        canonical: { mongo_id: canonical._id, mlbId: canonical.mlbId, fingerprint: fc },
        shadow: { mongo_id: shadow._id, fingerprint: fs },
        recommendation: "Manual merge: pick authoritative projection source, then delete or backfill shadow row.",
      });
      continue;
    }
    proposed.push({
      type: "PROPOSE_DELETE_SHADOW_DUPLICATE",
      match_key: key,
      rationale:
        "ObjectId-key row duplicates canonical MLB-id row (same normalized name + team); projections align within tolerance.",
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
      note: "No canonical same name+team row with mlbId; needs MLB Stats API id backfill or delete if junk.",
    });
  }

  const dupMlb = new Map<number, CatalogIdentityRow[]>();
  for (const r of rows) {
    if (!hasCanonicalMlbId(r)) continue;
    const id = Number(r.mlbId);
    if (!dupMlb.has(id)) dupMlb.set(id, []);
    dupMlb.get(id)!.push(r);
  }
  const dupMlbGroups = [...dupMlb.entries()].filter(([, arr]) => arr.length > 1);
  for (const [mlbId, arr] of dupMlbGroups) {
    conflicts.push({
      type: "DUPLICATE_MLBID",
      mlbId,
      mongo_ids: arr.map((x) => x._id),
      recommendation: "Keep one canonical document per mlbId; merge or delete extras after review.",
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    dry_run: true,
    policy:
      "Conservative: prefer rows with positive MLB Stats API mlbId. Never auto-delete in this script — export plan only.",
    counts: {
      shadow_pairs: shadows.length,
      proposed_operations: proposed.length,
      conflicts: conflicts.length,
      orphan_oid_without_shadow_match: orphans.length,
    },
    proposed_operations: proposed,
    conflicts,
  };

  const abs = path.join(ROOT, "tmp", "catalog-identity-repair-plan.json");
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(out, null, 2));

  console.log(
    JSON.stringify(
      {
        dry_run: true,
        proposed_operations: proposed.length,
        conflicts: conflicts.length,
        shadow_pairs: shadows.length,
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
