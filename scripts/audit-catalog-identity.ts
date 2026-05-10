/**
 * Mongo catalog identity audit (read-only).
 *
 *   pnpm audit:catalog-identity
 *
 * Writes tmp/catalog-identity-audit.json
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
  groupKeyName,
  groupKeyNamePosition,
  groupKeyNameTeam,
  hasCanonicalMlbId,
  normalizePlayerName,
  normalizeTeamAbbrev,
  projectionSummary,
  rowUsesObjectIdPlayerId,
  valuationPlayerIdFromRow,
} from "../src/lib/catalogIdentityHelpers";

const ROOT = path.resolve(__dirname, "..");

function numField(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** Normalize catalog_rank from current field or legacy Mongo `adp` (raw-doc fallback only). */
function catalogRankFromDoc(doc: Record<string, unknown>): number {
  const cr = numField(doc.catalog_rank);
  if (cr > 0) return cr;
  return numField(doc.adp);
}

/** Normalize catalog_tier from current field or legacy Mongo `tier` (raw-doc fallback only). */
function catalogTierFromDoc(doc: Record<string, unknown>): number {
  const ct = numField(doc.catalog_tier);
  if (ct > 0) return ct;
  return numField(doc.tier);
}

function toRow(doc: Record<string, unknown>): CatalogIdentityRow {
  return {
    _id: String(doc._id),
    mlbId: doc.mlbId as number | null | undefined,
    name: String(doc.name ?? ""),
    team: String(doc.team ?? ""),
    position: String(doc.position ?? ""),
    positions: Array.isArray(doc.positions) ? (doc.positions as string[]) : undefined,
    catalog_rank: catalogRankFromDoc(doc),
    catalog_tier: catalogTierFromDoc(doc),
    value: typeof doc.value === "number" ? doc.value : Number(doc.value) || 0,
    projection: doc.projection,
  };
}

function pairReport(canonical: CatalogIdentityRow, shadow: CatalogIdentityRow) {
  return {
    canonical: {
      mongo_id: canonical._id,
      mlbId: canonical.mlbId ?? null,
      name: canonical.name,
      team: canonical.team,
      position: canonical.position,
      positions: canonical.positions ?? [],
      catalog_rank: canonical.catalog_rank,
      catalog_tier: canonical.catalog_tier,
      projection_summary: projectionSummary(canonical.projection),
      value: canonical.value,
    },
    shadow: {
      mongo_id: shadow._id,
      mlbId: shadow.mlbId ?? null,
      name: shadow.name,
      team: shadow.team,
      position: shadow.position,
      positions: shadow.positions ?? [],
      catalog_rank: shadow.catalog_rank,
      catalog_tier: shadow.catalog_tier,
      projection_summary: projectionSummary(shadow.projection),
      value: shadow.value,
    },
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");
  await mongoose.connect(uri);
  let rows: CatalogIdentityRow[];
  try {
    const docs = await Player.find({})
      .select(
        "mlbId catalogKind name team position positions catalog_rank catalog_tier adp tier value projection"
      )
      .lean();
    rows = (docs as Record<string, unknown>[]).map(toRow);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const total = rows.length;
  const withMlb = rows.filter(hasCanonicalMlbId).length;
  const withoutMlb = total - withMlb;
  const oidPlayerIds = rows.filter(rowUsesObjectIdPlayerId).length;

  const dupNames = [...groupKeyName(rows).entries()].filter(([, arr]) => arr.length > 1);
  const dupNameTeam = [...groupKeyNameTeam(rows).entries()].filter(([, arr]) => arr.length > 1);
  const dupNamePos = [...groupKeyNamePosition(rows).entries()].filter(([, arr]) => arr.length > 1);
  const shadows = findShadowPairs(rows);
  const dupMlbGroups = findDuplicateMlbIdGroups(rows);
  const distinctMlbSameName = countSameNameDistinctMlbIdGroups(rows);
  let conflictReviewPairs = 0;
  let safeExactDuplicatePairs = 0;
  let manualRoleMismatchPairs = 0;
  for (const s of shadows) {
    const k = classifyShadowPair(s);
    if (k === "CONFLICT_REVIEW") conflictReviewPairs++;
    else if (k === "MANUAL_REVIEW_ROLE_MISMATCH") manualRoleMismatchPairs++;
    else safeExactDuplicatePairs++;
  }

  const sameNameDistinctSamples = dupNames
    .filter(([, arr]) => {
      const ids = new Set(arr.filter(hasCanonicalMlbId).map((r) => Number(r.mlbId)));
      return ids.size >= 2;
    })
    .slice(0, 20)
    .map(([k, arr]) => ({
      category: "SAME_NAME_DISTINCT_MLB_IDS",
      normalized_name: k,
      count: arr.length,
      distinct_mlbIds: [...new Set(arr.filter(hasCanonicalMlbId).map((r) => Number(r.mlbId)))].sort(
        (a, b) => a - b
      ),
      rows: arr.map((r) => ({
        mongo_id: r._id,
        mlbId: r.mlbId ?? null,
        name: r.name,
        team: r.team,
        position: r.position,
        valuation_player_id: valuationPlayerIdFromRow(r),
      })),
    }));

  const out = {
    generatedAt: new Date().toISOString(),
    summary: {
      total_catalog_rows: total,
      rows_with_mlbId: withMlb,
      rows_without_mlbId: withoutMlb,
      objectId_style_player_id_rows: oidPlayerIds,
      same_name_groups_total: dupNames.length,
      same_name_distinct_mlb_ids: distinctMlbSameName,
      likely_shadow_pairs: shadows.length,
      conflict_review_pairs: conflictReviewPairs,
      safe_exact_duplicate_pairs: safeExactDuplicatePairs,
      manual_role_review_pairs: manualRoleMismatchPairs,
      duplicate_mlb_id_groups: dupMlbGroups.size,
      same_name_team_key_group_count: dupNameTeam.length,
      same_name_position_key_group_count: dupNamePos.length,
      same_name_row_groups_note:
        "same_name_groups_total counts normalized-name clusters only (not duplicates). Use likely_shadow_pairs for OID↔mlbId shadow evidence; use same_name_distinct_mlb_ids for two different MLB people sharing a name.",
      shadow_oid_vs_canonical_pairs: shadows.length,
    },
    same_name_distinct_mlb_ids_samples: sameNameDistinctSamples,
    same_name_normalized_name_samples: dupNames.slice(0, 30).map(([k, arr]) => ({
      normalized_name: k,
      count: arr.length,
      note: "Same normalized name only — not a duplicate unless a likely_shadow_pair links OID↔mlbId with strong identity evidence.",
      rows: arr.map((r) => ({
        mongo_id: r._id,
        mlbId: r.mlbId ?? null,
        name: r.name,
        team: r.team,
        position: r.position,
        valuation_player_id: valuationPlayerIdFromRow(r),
      })),
    })),
    same_name_team_key_samples: dupNameTeam.slice(0, 25).map(([k, arr]) => ({
      key: k,
      count: arr.length,
      note: "Name + team key co-occurrence — not an automatic duplicate.",
      rows: arr.map((r) => ({
        mongo_id: r._id,
        mlbId: r.mlbId ?? null,
        name: r.name,
        team: r.team,
        position: r.position,
        valuation_player_id: valuationPlayerIdFromRow(r),
      })),
    })),
    same_name_position_key_samples: dupNamePos.slice(0, 20).map(([k, arr]) => ({
      key: k,
      count: arr.length,
      note: "Name + primary position key co-occurrence — not an automatic duplicate.",
      rows: arr.map((r) => ({
        mongo_id: r._id,
        mlbId: r.mlbId ?? null,
        name: r.name,
        team: r.team,
        position: r.position,
      })),
    })),
    suspected_shadow_pairs: shadows.map((s) => ({
      match_key: s.key,
      classification: classifyShadowPair(s),
      ...pairReport(s.canonical, s.shadow),
    })),
    duplicate_mlb_id_samples: [...dupMlbGroups.entries()].slice(0, 15).map(([mlbId, arr]) => ({
      mlbId,
      count: arr.length,
      mongo_ids: arr.map((r) => r._id),
    })),
    highest_risk_players: shadows.slice(0, 20).map((s) => ({
      name: s.shadow.name,
      team: s.shadow.team,
      shadow_mongo_id: s.shadow._id,
      canonical_mlbId: s.canonical.mlbId,
      canonical_mongo_id: s.canonical._id,
    })),
  };

  const abs = path.join(ROOT, "tmp", "catalog-identity-audit.json");
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(out, null, 2));

  console.log(JSON.stringify(out.summary, null, 2));
  console.error("Wrote", abs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
