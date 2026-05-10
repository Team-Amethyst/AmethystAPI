/**
 * Consolidates dry-run outputs into a prioritized cleanup plan + commented Mongo shell.
 *
 * Prerequisites (run first):
 *   pnpm audit:catalog-identity
 *   pnpm repair:catalog-identities
 *   pnpm export:catalog-cleanup-review
 * Optional:
 *   pnpm audit:valuation-factor-influence
 *
 * Writes (under repo tmp/, gitignored):
 *   tmp/catalog-cleanup-prioritized-plan.json
 *   tmp/catalog-cleanup-commented-mongo.js
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, "tmp");

type RepairPlan = {
  counts: Record<string, unknown>;
  conflict_review_pairs: Array<Record<string, unknown>>;
  manual_role_review_pairs: Array<Record<string, unknown>>;
  orphan_oid_without_shadow_match: Array<Record<string, unknown>>;
};

type ManualReview = {
  high_risk_players: Array<{
    player_name: string;
    canonical_mongo_id?: string | null;
    shadow_mongo_id?: string | null;
    classification?: string;
    recommended_action?: string;
    requires_human_approval?: boolean;
    proposed_commands?: Array<{ mongo_shell_commented: string }>;
  }>;
};

const OBJECT_ID_HEX = /^[a-f0-9]{24}$/i;

function loadJson<T>(abs: string): T | null {
  if (!existsSync(abs)) return null;
  return JSON.parse(readFileSync(abs, "utf8")) as T;
}

function oidPlayerIdsFromFactorAudit(abs: string): { top100Oids: Set<string>; suspiciousOids: Set<string> } {
  const top100Oids = new Set<string>();
  const suspiciousOids = new Set<string>();
  const fa = loadJson<{ top_100_detail?: Array<{ player_id: string; suspicious_flags?: string[] }> }>(abs);
  if (!fa?.top_100_detail) return { top100Oids, suspiciousOids };
  for (const r of fa.top_100_detail) {
    if (OBJECT_ID_HEX.test(r.player_id)) top100Oids.add(r.player_id);
    if ((r.suspicious_flags?.length ?? 0) > 0 && OBJECT_ID_HEX.test(r.player_id)) {
      suspiciousOids.add(r.player_id);
    }
  }
  return { top100Oids, suspiciousOids };
}

function commentedDelete(id: string, note: string): string {
  return `// db.players.deleteOne({ _id: ObjectId("${id}") }); // ${note}`;
}

function commentedUpdate(id: string, note: string): string {
  return `// db.players.updateOne({ _id: ObjectId("${id}") }, { $set: { /* fill after approval */ } }); // ${note}`;
}

async function main(): Promise<void> {
  const repairPath = path.join(TMP, "catalog-identity-repair-plan.json");
  const manualPath = path.join(TMP, "catalog-cleanup-manual-review.json");
  const factorPath = path.join(TMP, "valuation-factor-influence-audit.json");

  const repair = loadJson<RepairPlan>(repairPath);
  const manual = loadJson<ManualReview>(manualPath);
  if (!repair) {
    console.error(`Missing ${repairPath} — run pnpm repair:catalog-identities first.`);
    process.exit(1);
  }
  if (!manual) {
    console.error(`Missing ${manualPath} — run pnpm export:catalog-cleanup-review first.`);
    process.exit(1);
  }

  const { top100Oids, suspiciousOids } = existsSync(factorPath)
    ? oidPlayerIdsFromFactorAudit(factorPath)
    : { top100Oids: new Set<string>(), suspiciousOids: new Set<string>() };

  const namedHolds = new Set([
    "Cal Raleigh",
    "Trea Turner",
    "William Contreras",
    "Emmanuel Clase",
  ]);

  const prioritized: Record<string, unknown>[] = [];
  const mongoLines: string[] = [
    "// Commented Mongo shell — paste into mongosh after human approval. No writes executed by this file.",
    "// Policy: patch canonical (mlbId) projections before deleting shadow ObjectId rows when fingerprints conflict.",
    "",
  ];

  let rank = 0;
  for (const hr of manual.high_risk_players) {
    rank += 1;
    const gate =
      hr.player_name === "Cal Raleigh"
        ? "HOLD_UNTIL_CANONICAL_PROJECTION_FIXED"
        : hr.player_name === "Trea Turner" || hr.player_name === "William Contreras"
          ? "HOLD_UNTIL_SOURCE_CHOSEN"
          : hr.player_name === "Emmanuel Clase"
            ? "HOLD_UNTIL_P_RP_RESOLVED"
            : "REVIEW";

    prioritized.push({
      priority_rank: rank,
      tier: "P0_named_manual_review",
      player_name: hr.player_name,
      cleanup_gate: gate,
      canonical_mongo_id: hr.canonical_mongo_id ?? null,
      shadow_mongo_id: hr.shadow_mongo_id ?? null,
      classification: hr.classification ?? null,
      recommended_action: hr.recommended_action ?? null,
      requires_human_approval: hr.requires_human_approval !== false,
      proposed_mongo_commented: hr.proposed_commands?.map((c) => c.mongo_shell_commented) ?? [],
    });

    for (const c of hr.proposed_commands ?? []) {
      mongoLines.push(c.mongo_shell_commented);
    }
    mongoLines.push("");
  }

  for (const p of repair.manual_role_review_pairs) {
    const mk = String(p.match_key ?? "");
    const canon = (p.canonical as { mongo_id?: string })?.mongo_id;
    const sh = (p.shadow as { mongo_id?: string })?.mongo_id;
    const tier = mk.includes("emmanuel clase")
      ? "P1_role_mismatch_CLASE"
      : "P1_role_mismatch_other";
    prioritized.push({
      priority_rank: ++rank,
      tier,
      match_key: mk,
      type: "MANUAL_REVIEW_ROLE_MISMATCH",
      canonical_mongo_id: canon ?? null,
      shadow_mongo_id: sh ?? null,
      recommended_action:
        "Normalize P vs SP vs RP on canonical + shadow per product rules; merge projection; then allowlist shadow delete.",
      automatic_cleanup_safe: false,
      projection_fingerprint_note: "See repair plan projection_summary fields",
    });
    if (canon)
      mongoLines.push(commentedUpdate(canon, `role alignment canonical — ${mk}`));
    if (sh)
      mongoLines.push(commentedDelete(sh, `ONLY after role+projection merge — ${mk}`));
    mongoLines.push("");
  }

  for (const p of repair.conflict_review_pairs) {
    const mk = String(p.match_key ?? "");
    const canon = (p.canonical as { mongo_id?: string; mlbId?: number })?.mongo_id;
    const sh = (p.shadow as { mongo_id?: string })?.mongo_id;
    const shadowVid = sh ?? "";
    const inTop100 = shadowVid && top100Oids.has(shadowVid);
    const suspicious = shadowVid && suspiciousOids.has(shadowVid);

    const holdCal = mk.includes("cal raleigh");
    const holdTurner = mk.includes("trea turner");
    const holdContreras = mk.includes("william contreras");

    prioritized.push({
      priority_rank: ++rank,
      tier: holdCal || holdTurner || holdContreras ? "P2_conflict_named_hold" : "P2_conflict_review",
      match_key: mk,
      canonical_mongo_id: canon ?? null,
      shadow_mongo_id: sh ?? null,
      shadow_in_top100_auction_mass: inTop100,
      shadow_flagged_suspicious_in_factor_audit: suspicious,
      cleanup_gate: holdCal
        ? "HOLD_CAL_RALEIGH_FIX_CANONICAL_FIRST"
        : holdTurner
          ? "HOLD_TREA_TURNER_SOURCE"
          : holdContreras
            ? "HOLD_WILLIAM_CONTRERAS_SOURCE"
            : "MERGE_PROJECTION_THEN_DELETE_SHADOW",
      recommendation: p.recommendation,
      automatic_cleanup_safe: false,
    });

    if (canon)
      mongoLines.push(
        commentedUpdate(canon, `patch canonical projection after source choice — ${mk}`)
      );
    if (sh && !holdCal)
      mongoLines.push(commentedDelete(sh, `shadow duplicate — only post-merge — ${mk}`));
    if (sh && holdCal)
      mongoLines.push(
        `// (Cal Raleigh shadow delete intentionally omitted here — fix canonical 60-HR line first)`
      );
    mongoLines.push("");
  }

  for (const o of repair.orphan_oid_without_shadow_match ?? []) {
    prioritized.push({
      priority_rank: ++rank,
      tier: "P3_orphan_oid_no_shadow_pair",
      mongo_id: o.mongo_id,
      name: o.name,
      note: o.note,
      automatic_cleanup_safe: false,
    });
    mongoLines.push(
      commentedDelete(String(o.mongo_id), `ORPHAN — verify not duplicate of another mlbId row before delete: ${o.name}`)
    );
  }

  const out = {
    generatedAt: new Date().toISOString(),
    inputs: {
      repair_plan: repairPath,
      manual_review: manualPath,
      factor_audit: existsSync(factorPath) ? factorPath : null,
    },
    summary: {
      ...repair.counts,
      safe_exact_duplicate_pairs_from_classifier:
        (repair as unknown as { safe_exact_duplicate_pairs?: unknown[] }).safe_exact_duplicate_pairs
          ?.length ?? 0,
      named_manual_review_players: manual.high_risk_players.filter((x) =>
        namedHolds.has(x.player_name)
      ).length,
      interpretation:
        "repair:classifier reported safe_exact_duplicate_pairs = 0 — no shadow deletes are auto-safe until projections are merged.",
    },
    oid_overlap_factor_audit: {
      object_id_player_ids_in_top_100_detail: top100Oids.size,
      suspicious_oid_in_top_100: suspiciousOids.size,
    },
    prioritized_candidates: prioritized,
  };

  mkdirSync(TMP, { recursive: true });
  const planPath = path.join(TMP, "catalog-cleanup-prioritized-plan.json");
  const mongoPath = path.join(TMP, "catalog-cleanup-commented-mongo.js");
  writeFileSync(planPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  writeFileSync(mongoPath, `${mongoLines.join("\n")}\n`, "utf8");

  console.log(JSON.stringify({ wrote: planPath, mongo_comments: mongoPath, rows: prioritized.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
