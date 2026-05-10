/**
 * Read-only: load catalog players from Mongo and write a manual cleanup review file.
 *
 *   pnpm export:catalog-cleanup-review
 *
 * Output: tmp/catalog-cleanup-manual-review.json
 * Does not execute updateOne, deleteOne, or any write.
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
  hasCanonicalMlbId,
  normalizePlayerName,
  projectionFingerprint,
  projectionSummary,
  rowUsesObjectIdPlayerId,
} from "../src/lib/catalogIdentityHelpers";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "catalog-cleanup-manual-review.json");

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

function rowSnapshot(r: CatalogIdentityRow) {
  return {
    mongo_id: r._id,
    mlbId: r.mlbId ?? null,
    name: r.name,
    team: r.team,
    position: r.position,
    positions: r.positions ?? [],
    adp: r.adp,
    tier: r.tier,
    value: r.value,
    projection: r.projection ?? null,
    projection_summary: projectionSummary(r.projection),
    projection_fingerprint: projectionFingerprint(r.projection),
  };
}

function shadowPairForName(rows: CatalogIdentityRow[], normalized: string) {
  const pairs = findShadowPairs(rows);
  return pairs.find((p) => normalizePlayerName(p.canonical.name) === normalized) ?? null;
}

function nameDuplicateGroup(rows: CatalogIdentityRow[], normalized: string): CatalogIdentityRow[] {
  return [...groupKeyName(rows).entries()].find(([k]) => k === normalized)?.[1] ?? [];
}

function checklistBase(): string[] {
  return [
    "Authoritative projection source selected and documented",
    "Canonical mlbId row patched if projection or catalog fields need correction",
    "Shadow ObjectId-only row deleted only after projection conflict is resolved and merged if needed",
    "pnpm audit:catalog-identity and pnpm repair:catalog-identities re-run; JSON archived",
    "Spot-check valuation row for player_id === String(mlbId) after cleanup",
  ];
}

function commentedUpdateOne(filterId: string, note: string): string {
  return `// db.players.updateOne({ _id: ObjectId("${filterId}") }, { $set: { /* projection / adp / tier / team — fill after human approval */ } }); // ${note}`;
}

function commentedDeleteOne(filterId: string, note: string): string {
  return `// db.players.deleteOne({ _id: ObjectId("${filterId}") }); // ${note}`;
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri);
  let rows: CatalogIdentityRow[];
  let perdomoRows: CatalogIdentityRow[];
  try {
    const docs = await Player.find({})
      .select("mlbId name team position positions adp tier value projection")
      .lean();
    rows = (docs as Record<string, unknown>[]).map(toRow);

    const perdomoDocs = await Player.find({
      name: { $regex: /Geraldo\s+Perdomo/i },
    })
      .select("mlbId name team position positions adp tier value projection")
      .lean();
    perdomoRows = (perdomoDocs as Record<string, unknown>[]).map(toRow);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const total = rows.length;
  const withMlb = rows.filter(hasCanonicalMlbId).length;
  const withoutMlb = total - withMlb;
  const oidPlayerIds = rows.filter(rowUsesObjectIdPlayerId).length;
  const dupNameGroups = [...groupKeyName(rows).values()].filter((a) => a.length > 1).length;

  const cal = shadowPairForName(rows, "cal raleigh");
  const contreras = shadowPairForName(rows, "william contreras");
  const turner = shadowPairForName(rows, "trea turner");

  const claseGroup = nameDuplicateGroup(rows, "emmanuel clase");
  const claseWithMlb = claseGroup.filter(hasCanonicalMlbId);
  const claseOidOnly = claseGroup.filter((r) => !hasCanonicalMlbId(r));
  const claseCanon = claseWithMlb[0] ?? null;
  const claseShadow = claseOidOnly[0] ?? null;
  const clasePositionMismatch =
    claseCanon != null &&
    claseShadow != null &&
    claseCanon.position.trim().toUpperCase() !== claseShadow.position.trim().toUpperCase();

  const highRiskPlayers: Record<string, unknown>[] = [];

  if (cal) {
    highRiskPlayers.push({
      player_name: "Cal Raleigh",
      canonical_mongo_id: cal.canonical._id,
      canonical_mlbId: cal.canonical.mlbId ?? null,
      shadow_mongo_id: cal.shadow._id,
      canonical_projection: cal.canonical.projection ?? null,
      shadow_projection: cal.shadow.projection ?? null,
      canonical_projection_summary: projectionSummary(cal.canonical.projection),
      shadow_projection_summary: projectionSummary(cal.shadow.projection),
      canonical_projection_likely_invalid: true,
      classification: "duplicate_oid_shadow_plus_canonical_projection_bug",
      recommended_action:
        "Fix canonical (mlbId) projection from vetted source before deleting shadow; then delete shadow ObjectId row after fingerprints align or explicit approval.",
      risk_level: "critical",
      requires_human_approval: true,
      checklist: checklistBase(),
      proposed_commands: [
        {
          description: "Patch canonical projection after editorial approval (example placeholder fields)",
          mongo_shell_commented: commentedUpdateOne(
            cal.canonical._id,
            "replace projection.batting with validated stats — do not copy 60-HR line"
          ),
        },
        {
          description: "After conflict resolved, remove shadow duplicate",
          mongo_shell_commented: commentedDeleteOne(cal.shadow._id, "only after canonical fixed and merge complete"),
        },
      ],
    });
  }

  if (contreras) {
    highRiskPlayers.push({
      player_name: "William Contreras",
      canonical_mongo_id: contreras.canonical._id,
      canonical_mlbId: contreras.canonical.mlbId ?? null,
      shadow_mongo_id: contreras.shadow._id,
      canonical_projection: contreras.canonical.projection ?? null,
      shadow_projection: contreras.shadow.projection ?? null,
      canonical_projection_summary: projectionSummary(contreras.canonical.projection),
      shadow_projection_summary: projectionSummary(contreras.shadow.projection),
      classification: "projection_conflict_duplicate",
      recommended_action:
        "Manual choice of authoritative projection; patch canonical row; delete shadow after merge.",
      risk_level: "high",
      requires_human_approval: true,
      checklist: checklistBase(),
      proposed_commands: [
        {
          description: "Patch canonical to chosen stats",
          mongo_shell_commented: commentedUpdateOne(contreras.canonical._id, "merge chosen projection + catalog fields"),
        },
        {
          description: "Delete shadow duplicate",
          mongo_shell_commented: commentedDeleteOne(contreras.shadow._id, "post-merge only"),
        },
      ],
    });
  }

  if (turner) {
    highRiskPlayers.push({
      player_name: "Trea Turner",
      canonical_mongo_id: turner.canonical._id,
      canonical_mlbId: turner.canonical.mlbId ?? null,
      shadow_mongo_id: turner.shadow._id,
      canonical_projection: turner.canonical.projection ?? null,
      shadow_projection: turner.shadow.projection ?? null,
      canonical_projection_summary: projectionSummary(turner.canonical.projection),
      shadow_projection_summary: projectionSummary(turner.shadow.projection),
      classification: "projection_conflict_duplicate",
      recommended_action:
        "Manual source choice (e.g. SB-heavy vs balanced line); patch canonical; delete shadow after merge.",
      risk_level: "high",
      requires_human_approval: true,
      checklist: checklistBase(),
      proposed_commands: [
        {
          description: "Patch canonical projection",
          mongo_shell_commented: commentedUpdateOne(turner.canonical._id, "chosen vendor / scout line"),
        },
        {
          description: "Delete shadow duplicate",
          mongo_shell_commented: commentedDeleteOne(turner.shadow._id, "post-merge only"),
        },
      ],
    });
  }

  highRiskPlayers.push({
    player_name: "Emmanuel Clase",
    canonical_mongo_id: claseCanon?._id ?? null,
    canonical_mlbId: claseCanon?.mlbId ?? null,
    shadow_mongo_id: claseShadow?._id ?? null,
    canonical_projection: claseCanon?.projection ?? null,
    shadow_projection: claseShadow?.projection ?? null,
    canonical_projection_summary: claseCanon ? projectionSummary(claseCanon.projection) : "",
    shadow_projection_summary: claseShadow ? projectionSummary(claseShadow.projection) : "",
    duplicate_name_group_size: claseGroup.length,
    duplicate_rows_snapshot: claseGroup.map(rowSnapshot),
    position_mismatch_P_vs_RP: clasePositionMismatch,
    classification: "position_code_duplicate_mismatch_oid_vs_canonical",
    recommended_action:
      "Normalize primary position (P vs RP) on both docs so tooling can fingerprint-compare; then merge into mlbId row and delete ObjectId shadow.",
    risk_level: "high",
    requires_human_approval: true,
    checklist: [
      ...checklistBase().slice(0, 3),
      "Normalize P/RP consistently before dedupe (product rule)",
      ...checklistBase().slice(3),
    ],
    proposed_commands: [
      {
        description: "Align position code on shadow row (example)",
        mongo_shell_commented:
          claseShadow != null
            ? `// db.players.updateOne({ _id: ObjectId("${claseShadow._id}") }, { $set: { position: "P" } }); // or set canonical to RP — pick one standard`
            : "// (no shadow row resolved — inspect duplicate_rows_snapshot)",
      },
      {
        description: "After alignment + merge, delete ObjectId shadow",
        mongo_shell_commented:
          claseShadow != null
            ? commentedDeleteOne(claseShadow._id, "only after canonical holds merged RP stats")
            : "// (no shadow id)",
      },
    ],
  });

  const perdomoCanon = perdomoRows.length === 1 && hasCanonicalMlbId(perdomoRows[0]!) ? perdomoRows[0]! : null;
  highRiskPlayers.push({
    player_name: "Geraldo Perdomo",
    canonical_mongo_id: perdomoCanon?._id ?? null,
    canonical_mlbId: perdomoCanon?.mlbId ?? null,
    shadow_mongo_id: null,
    canonical_projection: perdomoCanon?.projection ?? null,
    shadow_projection: null,
    lookup_task: {
      description:
        "Not in duplicate/shadow audit slice; script ran direct name regex lookup — re-verify in shell before any write.",
      suggested_queries: [
        "// db.players.find({ name: /Geraldo\\s+Perdomo/i }).pretty()",
        "// db.players.find({ mlbId: 672695 }).pretty()",
      ],
    },
    rows_from_name_lookup: perdomoRows.map(rowSnapshot),
    classification:
      perdomoRows.length === 0
        ? "direct_lookup_required"
        : perdomoRows.length === 1
          ? "single_row_projection_review"
          : "multiple_rows_manual_classify",
    recommended_action:
      perdomoRows.length === 0
        ? "Confirm player exists in catalog under alternate spelling; if single row, treat as projection-only patch on that document."
        : perdomoRows.length === 1
          ? "Single mlbId row in catalog: no OID shadow in this export — review projection.batting vs source (flag if extreme); patch projection only if needed."
          : "Classify each returned row: duplicate vs single; if duplicate apply canonical+shadow playbook; else patch projection only.",
    risk_level: perdomoRows.length > 1 ? "high" : perdomoRows.length === 1 ? "medium" : "medium",
    requires_human_approval: true,
    checklist: [
      "Run suggested_queries in Mongo shell (read-only first)",
      "If one row: verify projection.batting fields vs source feed",
      "If two+ rows: map canonical (mlbId) vs shadow before any delete",
      "Re-run pnpm audit:catalog-identity after changes",
    ],
    proposed_commands:
      perdomoRows.length > 0
        ? perdomoRows.map((r, i) => ({
            description: `Optional patch for row ${i + 1} (${r._id}) after human review`,
            mongo_shell_commented: commentedUpdateOne(r._id, "projection / adp / tier — only if approved"),
          }))
        : [
            {
              description: "No rows matched name regex; manual find",
              mongo_shell_commented: "// db.players.find({ name: /Perdomo/i }).limit(20).pretty()",
            },
          ],
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    policy:
      "Zero automatic destructive action. All proposed_commands are commented strings for manual copy-paste after approval.",
    global_summary: {
      total_catalog_rows: total,
      rows_with_mlbId: withMlb,
      rows_without_mlbId: withoutMlb,
      objectId_style_valuation_player_id_rows: oidPlayerIds,
      duplicate_normalized_name_groups: dupNameGroups,
      suspected_shadow_pairs_count: findShadowPairs(rows).length,
    },
    high_risk_players: highRiskPlayers,
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ wrote: OUT, high_risk_count: highRiskPlayers.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
