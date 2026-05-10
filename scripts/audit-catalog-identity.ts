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

function pairReport(canonical: CatalogIdentityRow, shadow: CatalogIdentityRow) {
  return {
    canonical: {
      mongo_id: canonical._id,
      mlbId: canonical.mlbId ?? null,
      name: canonical.name,
      team: canonical.team,
      position: canonical.position,
      positions: canonical.positions ?? [],
      adp: canonical.adp,
      tier: canonical.tier,
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
      adp: shadow.adp,
      tier: shadow.tier,
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
      .select("mlbId name team position positions adp tier value projection")
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

  const out = {
    generatedAt: new Date().toISOString(),
    summary: {
      total_catalog_rows: total,
      rows_with_mlbId: withMlb,
      rows_without_mlbId: withoutMlb,
      objectId_style_player_id_rows: oidPlayerIds,
      duplicate_normalized_name_groups: dupNames.length,
      duplicate_name_team_groups: dupNameTeam.length,
      duplicate_name_position_groups: dupNamePos.length,
      shadow_oid_vs_canonical_pairs: shadows.length,
    },
    duplicate_name_samples: dupNames.slice(0, 30).map(([k, arr]) => ({
      normalized_name: k,
      count: arr.length,
      rows: arr.map((r) => ({
        mongo_id: r._id,
        mlbId: r.mlbId ?? null,
        name: r.name,
        team: r.team,
        position: r.position,
        valuation_player_id: valuationPlayerIdFromRow(r),
      })),
    })),
    duplicate_name_team_samples: dupNameTeam.slice(0, 25).map(([k, arr]) => ({
      key: k,
      count: arr.length,
      rows: arr.map((r) => ({
        mongo_id: r._id,
        mlbId: r.mlbId ?? null,
        name: r.name,
        team: r.team,
        position: r.position,
        valuation_player_id: valuationPlayerIdFromRow(r),
      })),
    })),
    duplicate_name_position_samples: dupNamePos.slice(0, 20).map(([k, arr]) => ({
      key: k,
      count: arr.length,
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
      ...pairReport(s.canonical, s.shadow),
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
