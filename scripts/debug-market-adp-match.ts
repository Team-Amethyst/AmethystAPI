/**
 * Diagnostics: NFBC vendor row ↔ Mongo catalog matching (dry-run helpers only; no writes).
 *
 *   MONGO_URI=... pnpm exec ts-node --project tsconfig.scripts.json scripts/debug-market-adp-match.ts
 *
 * Optional: reuse cached NFBC body from a file instead of fetching:
 *   NFBC_DEBUG_BODY_FILE=tmp/nfbc-raw-body.html pnpm exec ts-node ...
 */
import dotenv from "dotenv";
import { readFileSync, existsSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import {
  canonicalMlbTeamAbbrevForMatch,
  normalizePlayerName,
} from "../src/lib/catalogIdentityHelpers";
import {
  parseNfbcDataPhpText,
  resolveNfbcDataPhpUrl,
  resolveNfbcAuthorizationFromEnv,
  resolveNfbcFetchTimeoutMsFromEnv,
} from "../src/lib/marketAdp";
import {
  catalogEligiblePositionsCompatible,
  positionCompatible,
} from "../src/lib/marketAdp/matchDryRun";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { getPlayerId } from "../src/lib/playerId";
import type { LeanPlayer } from "../src/types/core";
import type { MarketAdpVendorRow } from "../src/lib/marketAdp/types";

dotenv.config();

const TARGETS = [
  "Aaron Judge",
  "Juan Soto",
  "Ronald Acuña Jr.",
  "Julio Rodríguez",
  "Corbin Carroll",
  "Fernando Tatis Jr.",
  "Kyle Tucker",
  "Pete Alonso",
] as const;

function catalogTokens(p: LeanPlayer): string[] {
  const slots = [p.position, ...(p.positions ?? [])].filter(
    (s): s is string => typeof s === "string" && s.trim() !== ""
  );
  const out: string[] = [];
  for (const s of slots) {
    for (const t of s.split(/[,/]/).map((x) => x.trim()).filter(Boolean)) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

function findVendorRowForTarget(
  rows: MarketAdpVendorRow[],
  targetLabel: string
): MarketAdpVendorRow | undefined {
  const want = normalizePlayerName(targetLabel);
  return rows.find((r) => normalizePlayerName(r.name) === want);
}

function catalogNameMatches(catalog: LeanPlayer[], needle: string): LeanPlayer[] {
  const n = normalizePlayerName(needle);
  return catalog.filter((p) => normalizePlayerName(p.name) === n);
}

function diagnose(
  label: string,
  v: MarketAdpVendorRow | undefined,
  catalog: LeanPlayer[]
): void {
  console.log(`\n========== ${label} ==========`);
  if (!v) {
    console.log("Vendor row: NOT FOUND in NFBC payload (name normalization mismatch?)");
    return;
  }
  const vn = normalizePlayerName(v.name);
  const vt = canonicalMlbTeamAbbrevForMatch(v.team);
  console.log("Vendor raw name:", v.name);
  console.log("Vendor normalized name:", vn);
  console.log("Vendor team:", v.team);
  console.log("Canonical vendor team (match key):", vt);
  console.log("Vendor positions string:", v.position);
  const cands = catalogNameMatches(catalog, v.name);
  console.log("Catalog rows with same normalized name:", cands.length);
  for (const p of cands) {
    const cn = normalizePlayerName(p.name);
    const ct = canonicalMlbTeamAbbrevForMatch(p.team);
    const compat = catalogEligiblePositionsCompatible(p, v.position);
    const pcPrimary = positionCompatible(p.position, v.position);
    console.log("--- catalog candidate ---");
    console.log("  player_id:", getPlayerId(p), "mlbId:", p.mlbId);
    console.log("  catalog name:", p.name);
    console.log("  catalog normalized name:", cn);
    console.log("  catalog team:", p.team, "→ canonical:", ct);
    console.log("  catalog position (primary):", p.position);
    console.log("  catalog positions[]:", p.positions ?? "(none)");
    console.log("  effective position tokens:", catalogTokens(p));
    console.log("  positionCompatible(primary, vendor):", pcPrimary);
    console.log("  catalogEligiblePositionsCompatible:", compat);
    console.log("  team match (canonical):", ct === vt || ct === "--" || vt === "--");
  }
  if (cands.length === 0) {
    console.log("Reason: no catalog player shares normalized name with vendor.");
    return;
  }
  const withTeam = cands.filter(
    (p) =>
      canonicalMlbTeamAbbrevForMatch(p.team) === vt ||
      canonicalMlbTeamAbbrevForMatch(p.team) === "--" ||
      vt === "--"
  );
  if (withTeam.length === 0) {
    console.log(
      "Reason: normalized name hit(s) but canonical team mismatch:",
      cands.map((p) => `${p.name} team=${p.team}→${canonicalMlbTeamAbbrevForMatch(p.team)}`).join(" | ")
    );
    return;
  }
  const ok = withTeam.filter((p) => catalogEligiblePositionsCompatible(p, v.position));
  if (ok.length === 0) {
    console.log(
      "Reason: team OK but no catalog slot compatible with vendor eligibility:",
      v.position
    );
    return;
  }
  if (ok.length > 1) {
    console.log("Reason: multiple catalog rows would match (ambiguous):", ok.map(getPlayerId).join(", "));
    return;
  }
  console.log("Reason: would match uniquely in isolation:", getPlayerId(ok[0]!));
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI?.trim();
  if (!uri) throw new Error("MONGO_URI required");

  let body: string;
  const bodyFile = process.env.NFBC_DEBUG_BODY_FILE?.trim();
  if (bodyFile) {
    const abs = path.isAbsolute(bodyFile) ? bodyFile : path.join(process.cwd(), bodyFile);
    if (!existsSync(abs)) throw new Error(`NFBC_DEBUG_BODY_FILE not found: ${abs}`);
    body = readFileSync(abs, "utf8");
  } else {
    const url = resolveNfbcDataPhpUrl();
    const fetchMod = await import("../src/lib/marketAdp/nfbcRemoteCsv");
    body = await fetchMod.fetchNfbcCsvText(url, {
      timeoutMs: resolveNfbcFetchTimeoutMsFromEnv(),
      authorization: resolveNfbcAuthorizationFromEnv(),
    });
  }

  const vendorRows = parseNfbcDataPhpText(body).rows;

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let catalog: LeanPlayer[] = [];
  try {
    process.env.AMETHYST_SKIP_MLB_TEAM_HYDRATE = "1";
    catalog = await loadMongoCatalogForEngine(
      { warn: console.warn, info: console.info },
      { skipMlbHydration: true }
    );
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  console.log(JSON.stringify({ vendor_rows: vendorRows.length, catalog_players: catalog.length }, null, 2));

  for (const t of TARGETS) {
    const v = findVendorRowForTarget(vendorRows, t);
    diagnose(t, v, catalog);
  }

  const judge = catalog.find((p) => normalizePlayerName(p.name) === normalizePlayerName("Aaron Judge"));
  console.log("\n========== Aaron Judge catalog snapshot ==========");
  if (!judge) console.log("No catalog row named Aaron Judge");
  else {
    console.log(JSON.stringify(judge, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
