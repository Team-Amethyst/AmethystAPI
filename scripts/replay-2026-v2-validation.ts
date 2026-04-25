/**
 * Replay 2026 draft checkpoint JSONs with replacement_slots_v2 and report
 * per-pick errors vs prior-step adjusted_value plus checkpoint summaries.
 *
 * Catalog:
 * - Default: Mongo `players` (lean catalog) merged with fixture player_ids
 *   (synthetic sequential ids are re-keyed from Mongo rows matched by name/team).
 * - `--proxy-only`: synthetic ~920-player pool from fixtures (PROXY-ONLY banner).
 * - `--exclude-stubs`: omit stub-backed picks from error summaries and large-miss lists
 *   (TSV still lists all picks); counts how many were excluded.
 *
 * Requires MONGO_URI unless `--proxy-only`.
 *
 * Run: pnpm replay-2026-v2 [--proxy-only] [--exclude-stubs]
 *       pnpm replay-2026-v2 --baseline-overrides[=path]   (Mongo replay only; patches in-memory Player.value)
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import type { DraftedPlayer, LeanPlayer, NormalizedValuationInput } from "../src/types/brain";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { PLAYER_CATALOG_LEAN_SELECT } from "../src/lib/playerCatalogProjection";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import {
  fitsRosterSlot,
  playerTokensFromDrafted,
  playerTokensFromLean,
} from "../src/lib/fantasyRosterSlots";
import { buildRosteredPlayersForSlotEngine } from "../src/lib/rosteredPlayersForSlots";
import Player from "../src/models/Player";

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "test-fixtures/replay-evaluator/manifest.json");
const CHECKPOINT_DIR = path.join(ROOT, "test-fixtures/player-api/checkpoints");
const FINAL_CP = path.join(CHECKPOINT_DIR, "after_pick_130.json");
const PRE_DRAFT = path.join(CHECKPOINT_DIR, "pre_draft.json");
const CONVERSION_REPORT = path.join(CHECKPOINT_DIR, "conversion-match-report.json");
const MISSING_CATALOG_REPORT = path.join(ROOT, "test-fixtures/replay-evaluator/missing-catalog-report.json");
const DEFAULT_BASELINE_OVERRIDES = path.join(ROOT, "test-fixtures/replay-evaluator/baseline-value-overrides.json");
const TOP_AVAIL_N = 20;

type BaselineOverrideEntry = { value: number };
type BaselineOverridesFile = {
  audit?: Array<Record<string, unknown>>;
  overrides?: Record<string, BaselineOverrideEntry>;
};

type BaselineReplayMetrics = {
  meanAeMatchedById: number;
  nMatched: number;
  nLargeMatchedById: number;
};

function parseBaselineOverridesPath(argv: string[]): string | null {
  const idx = argv.findIndex((a) => a === "--baseline-overrides" || a.startsWith("--baseline-overrides="));
  if (idx === -1) return null;
  const a = argv[idx]!;
  if (a === "--baseline-overrides") {
    const next = argv[idx + 1];
    if (next && !next.startsWith("-")) {
      return path.isAbsolute(next) ? next : path.join(ROOT, next);
    }
    return DEFAULT_BASELINE_OVERRIDES;
  }
  const rest = a.slice("--baseline-overrides=".length);
  return rest ? (path.isAbsolute(rest) ? rest : path.join(ROOT, rest)) : DEFAULT_BASELINE_OVERRIDES;
}

function clonePool(pool: LeanPlayer[]): LeanPlayer[] {
  return pool.map((p) => ({ ...p }));
}

function applyBaselineOverrides(
  pool: LeanPlayer[],
  overrides: Record<string, BaselineOverrideEntry> | undefined
): { player_id: string; before: number; after: number }[] {
  if (!overrides) return [];
  const log: { player_id: string; before: number; after: number }[] = [];
  for (const p of pool) {
    if (p.mlbId == null || !Number.isFinite(p.mlbId)) continue;
    const id = String(p.mlbId);
    const o = overrides[id];
    if (!o) continue;
    const before = typeof p.value === "number" && Number.isFinite(p.value) ? p.value : 0;
    log.push({ player_id: id, before, after: o.value });
    p.value = o.value;
  }
  return log;
}

/**
 * Silent pass: MAE of |paid - prev_adj| over new auction picks with replay_catalog_status matched_by_id only.
 * Does not mutate params.pool (caller passes a clone if needed).
 */
async function computeBaselineReplayMetrics(params: {
  manifest: Manifest;
  pool: LeanPlayer[];
  conversionLookup: Map<string, ConvLookup>;
  fixtureReplayStatus: Map<string, ReplayCatalogStatus>;
  proxyOnly: boolean;
}): Promise<BaselineReplayMetrics> {
  const poolByMlb = poolPlayerByMlbId(params.pool);
  let prevNorm: NormalizedValuationInput | null = null;
  const prevAdj = new Map<string, number>();
  const absMatched: number[] = [];
  let nLarge = 0;

  for (const step of params.manifest.steps) {
    const reqPath = path.join(ROOT, step.request_path);
    if (!existsSync(reqPath)) continue;
    const raw = JSON.parse(readFileSync(reqPath, "utf8")) as Record<string, unknown>;
    const merged = {
      ...raw,
      inflation_model: raw.inflation_model ?? "replacement_slots_v2",
    };
    const parsed = parseValuationRequest(merged);
    if (!parsed.success) continue;
    const n = parsed.normalized;
    const out = executeValuationWorkflow(params.pool, n, {});
    if (!out.ok) {
      prevNorm = n;
      prevAdj.clear();
      continue;
    }
    const res = out.response;
    const picks = newAuctionPicks(prevNorm, n);
    for (const p of picks) {
      const replay_catalog_status = replayStatusForPlayerId(
        p.player_id,
        params.proxyOnly,
        params.fixtureReplayStatus,
        poolByMlb
      );
      if (replay_catalog_status !== "matched_by_id") continue;
      const adj0 = prevAdj.get(p.player_id);
      const paid = p.paid ?? 0;
      if (adj0 == null || !Number.isFinite(adj0) || !Number.isFinite(paid)) continue;
      const delta = paid - adj0;
      absMatched.push(Math.abs(delta));
      if (Math.abs(delta) >= 15) nLarge += 1;
    }

    prevAdj.clear();
    for (const r of res.valuations) {
      prevAdj.set(r.player_id, r.adjusted_value);
    }
    prevNorm = n;
  }

  const meanAeMatchedById = absMatched.length ? mean(absMatched) : NaN;
  return { meanAeMatchedById, nMatched: absMatched.length, nLargeMatchedById: nLarge };
}

type ConversionReportFile = {
  entries?: {
    player_id: string;
    catalog_match_status?: string;
    match_method?: string;
  }[];
  pick_gaps?: number[];
  duplicate_pick_numbers?: number[];
  summary?: { stub_unresolved_count?: number };
};

type ConvLookup = { catalog_match_status: string; match_method: string };

/** Replay-only: how fixture identity joined the Mongo-backed pool (not valuation math). */
type ReplayCatalogStatus =
  | "matched_by_id"
  | "matched_by_name"
  | "stub_unresolved_name"
  | "stub_missing_in_catalog"
  | "synthetic_fixture_id"
  | "proxy_pool";

const SYNTHETIC_ID_MIN = 9_000_001;

function isSyntheticFixturePlayerId(pid: string): boolean {
  const n = Number(pid);
  return Number.isFinite(n) && n >= SYNTHETIC_ID_MIN;
}

function isDataIssueReplayStatus(s: ReplayCatalogStatus): boolean {
  return (
    s === "stub_unresolved_name" ||
    s === "stub_missing_in_catalog" ||
    s === "synthetic_fixture_id"
  );
}

function loadConversionReport(): Map<string, ConvLookup> {
  if (!existsSync(CONVERSION_REPORT)) return new Map();
  try {
    const j = JSON.parse(readFileSync(CONVERSION_REPORT, "utf8")) as ConversionReportFile;
    const m = new Map<string, ConvLookup>();
    for (const e of j.entries ?? []) {
      m.set(String(e.player_id), {
        catalog_match_status: e.catalog_match_status ?? "unknown",
        match_method: e.match_method ?? "unknown",
      });
    }
    return m;
  } catch {
    return new Map();
  }
}

type Manifest = {
  steps: { label: string; request_path: string }[];
};

type FixtureMeta = { name: string; position: string; team: string };

function normPos(p: string): string {
  const u = p.toUpperCase().trim();
  if (u.includes("RP") && !u.includes("SP")) return "RP";
  if (u.includes("SP")) return "SP";
  if (u.startsWith("P") && u.length <= 2) return "SP";
  return u.split(/[,/]/)[0]?.trim() || "OF";
}

const REPL_KEY_ORDER = [
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "MI",
  "CI",
  "OF",
  "UTIL",
  "SP",
  "RP",
  "P",
] as const;

function replacementForPosition(
  repl: Record<string, number> | undefined,
  position: string
): { key: string; value: number } | null {
  if (!repl) return null;
  const u = position.toUpperCase();
  for (const k of REPL_KEY_ORDER) {
    if (repl[k] == null) continue;
    if (u.includes(k)) return { key: k, value: repl[k]! };
    if (k === "MI" && (u.includes("2B") || u.includes("SS"))) return { key: k, value: repl[k]! };
    if (k === "P" && (u.includes("SP") || u.includes("RP"))) return { key: k, value: repl[k]! };
  }
  return null;
}

function buildCatalogFromFixtures(): LeanPlayer[] {
  const final = JSON.parse(readFileSync(FINAL_CP, "utf8")) as {
    drafted_players: DraftedPlayer[];
  };
  const pre = JSON.parse(readFileSync(PRE_DRAFT, "utf8")) as {
    pre_draft_rosters?: { team_id: string; players: DraftedPlayer[] }[];
  };
  const byId = new Map<string, LeanPlayer>();
  const add = (id: string, name: string, position: string, pick: number) => {
    const n = normPos(position);
    const value = Math.max(2, 220 - pick * 1.15);
    byId.set(id, {
      _id: `mlb_${id}`,
      mlbId: Number(id),
      name,
      team: "UNK",
      position: n,
      adp: pick,
      tier: pick <= 40 ? 1 : pick <= 90 ? 2 : 3,
      value: Math.round(value * 100) / 100,
    });
  };

  for (const dp of final.drafted_players) {
    const pick = dp.pick_number ?? 999;
    add(dp.player_id, dp.name, dp.position, pick);
  }

  if (Array.isArray(pre.pre_draft_rosters)) {
    for (const b of pre.pre_draft_rosters) {
      for (const p of b.players ?? []) {
        if (byId.has(p.player_id)) continue;
        const v = 38 + (p.player_id.length % 17);
        byId.set(p.player_id, {
          _id: `mlb_${p.player_id}`,
          mlbId: Number(p.player_id),
          name: p.name,
          team: p.team ?? "UNK",
          position: normPos(p.position),
          adp: 400 + byId.size,
          tier: 3,
          value: v,
        });
      }
    }
  }

  const used = new Set(byId.keys());
  let filler = 0;
  const positions = ["OF", "OF", "SP", "RP", "C", "SS", "2B", "1B", "3B", "OF"];
  while (byId.size < 920) {
    const id = 90000 + filler;
    const idStr = String(id);
    if (used.has(idStr)) {
      filler++;
      continue;
    }
    const pos = positions[filler % positions.length];
    const v = Math.max(1.5, 28 - filler * 0.025);
    byId.set(idStr, {
      _id: `f_${idStr}`,
      mlbId: id,
      name: `Filler_${idStr}`,
      team: "NYY",
      position: pos,
      adp: 200 + filler,
      tier: 4,
      value: Math.round(v * 100) / 100,
    });
    filler++;
  }

  return [...byId.values()];
}

function collectFromBuckets(
  buckets: unknown,
  into: Map<string, FixtureMeta>,
  canonicalNameById: Map<string, string>
): void {
  if (!Array.isArray(buckets)) return;
  for (const b of buckets) {
    if (typeof b !== "object" || b == null) continue;
    const players = (b as { players?: DraftedPlayer[] }).players;
    if (!Array.isArray(players)) continue;
    for (const p of players) {
      if (!p.player_id) continue;
      const name = canonicalNameById.get(p.player_id) ?? p.name;
      into.set(p.player_id, {
        name,
        position: p.position,
        team: p.team ?? "",
      });
    }
  }
}

function loadCanonicalNameByPlayerId(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(CONVERSION_REPORT)) return map;
  try {
    const j = JSON.parse(readFileSync(CONVERSION_REPORT, "utf8")) as {
      entries?: { player_id: string; canonical_name?: string }[];
    };
    for (const e of j.entries ?? []) {
      if (e.canonical_name?.trim()) map.set(String(e.player_id), e.canonical_name.trim());
    }
  } catch {
    /* ignore */
  }
  return map;
}

function collectFixtureIdentityMap(
  manifest: Manifest,
  canonicalNameById: Map<string, string>
): Map<string, FixtureMeta> {
  const m = new Map<string, FixtureMeta>();
  for (const step of manifest.steps) {
    const reqPath = path.join(ROOT, step.request_path);
    if (!existsSync(reqPath)) continue;
    const raw = JSON.parse(readFileSync(reqPath, "utf8")) as Record<string, unknown>;
    const drafted = raw.drafted_players as DraftedPlayer[] | undefined;
    if (Array.isArray(drafted)) {
      for (const p of drafted) {
        if (!p.player_id) continue;
        const name = canonicalNameById.get(p.player_id) ?? p.name;
        m.set(p.player_id, {
          name,
          position: p.position,
          team: p.team ?? "",
        });
      }
    }
    collectFromBuckets(raw.pre_draft_rosters, m, canonicalNameById);
    collectFromBuckets(raw.minors, m, canonicalNameById);
    collectFromBuckets(raw.taxi, m, canonicalNameById);
  }
  return m;
}

function namesLooselyMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** ASCII fold for loose display-name comparison (e.g. Jesús vs Jesus). */
function foldDisplayName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
}

function namesLooselyMatchFolded(a: string, b: string): boolean {
  return foldDisplayName(a) === foldDisplayName(b);
}

/**
 * Merge Mongo catalog with fixture player_ids for replay.
 * Prefer Mongo row by mlbId when fixture id matches (canonical MLB ids in checkpoints).
 * Fall back to folded display-name match (+ team tie-break) when id is absent in Mongo.
 * Re-key matched rows to fixture numeric id so drafted_players align with pool getPlayerId.
 * Drop original Mongo rows that were re-keyed to avoid double-counting one human as two pool entries.
 */
function replayStubCategoryForMergeFailure(
  fid: string,
  conversionLookup: Map<string, ConvLookup>
): ReplayCatalogStatus {
  if (isSyntheticFixturePlayerId(fid)) return "synthetic_fixture_id";
  const conv = conversionLookup.get(fid);
  const unresolved =
    conv?.catalog_match_status === "stub" || conv?.match_method === "synthetic_unresolved";
  if (unresolved) return "stub_unresolved_name";
  return "stub_missing_in_catalog";
}

function mergeMongoCatalogForFixtures(
  mongo: LeanPlayer[],
  fixtureById: Map<string, FixtureMeta>,
  conversionLookup: Map<string, ConvLookup>
): { pool: LeanPlayer[]; warnings: string[]; fixtureReplayStatus: Map<string, ReplayCatalogStatus> } {
  const warnings: string[] = [];
  const consumedSourceMlbIds = new Set<number>();
  const rekeyed = new Map<number, LeanPlayer>();
  const fixtureReplayStatus = new Map<string, ReplayCatalogStatus>();

  const byMlbId = new Map<number, LeanPlayer>();
  for (const p of mongo) {
    if (p.mlbId != null && Number.isFinite(p.mlbId)) byMlbId.set(p.mlbId, p);
  }

  const nameIndex = new Map<string, LeanPlayer[]>();
  for (const p of mongo) {
    const k = foldDisplayName(p.name);
    if (!nameIndex.has(k)) nameIndex.set(k, []);
    nameIndex.get(k)!.push(p);
  }

  for (const [fid, meta] of fixtureById) {
    const idNum = Number(fid);
    if (!Number.isFinite(idNum)) continue;

    const direct = byMlbId.get(idNum);
    let src: LeanPlayer | undefined;
    let matchedBy: "id" | "name" | null = null;
    if (direct) {
      // Fixtures now carry real MLB ids whenever possible; trust mlbId over
      // display-string equality (accents, Jr., abbreviations in sheet-derived names).
      src = direct;
      matchedBy = "id";
      if (meta.name.trim() && !namesLooselyMatchFolded(direct.name, meta.name)) {
        warnings.push(
          `fixture id ${fid}: name "${meta.name}" vs Mongo "${direct.name}"; using Mongo row by mlbId`
        );
      }
    }

    if (!src) {
      const list = nameIndex.get(foldDisplayName(meta.name));
      if (list && list.length === 1) {
        src = list[0];
        matchedBy = "name";
      } else if (list && list.length > 1) {
        const teamU = (meta.team ?? "").toUpperCase();
        src =
          list.find((p) => (p.team ?? "").toUpperCase() === teamU) ??
          list[0] ??
          undefined;
        if (src) matchedBy = "name";
        if (list.length > 1 && !list.find((p) => (p.team ?? "").toUpperCase() === teamU)) {
          warnings.push(
            `ambiguous name "${meta.name}" for fixture id ${fid}; picked first of ${list.length}`
          );
        }
      }
    }

    if (src) {
      if (src.mlbId != null && src.mlbId !== idNum) {
        consumedSourceMlbIds.add(src.mlbId);
      }
      rekeyed.set(idNum, {
        ...src,
        mlbId: idNum,
        name: meta.name || src.name,
        team: meta.team || src.team,
        position: normPos(meta.position || src.position),
      });
      fixtureReplayStatus.set(fid, matchedBy === "id" ? "matched_by_id" : "matched_by_name");
    } else {
      warnings.push(`no Mongo row for fixture id ${fid} (${meta.name}); stub baseline 0`);
      const st = replayStubCategoryForMergeFailure(fid, conversionLookup);
      fixtureReplayStatus.set(fid, st);
      rekeyed.set(idNum, {
        _id: `fixture_stub_${idNum}`,
        mlbId: idNum,
        name: meta.name || "Unknown",
        team: meta.team || "",
        position: normPos(meta.position),
        adp: 9999,
        tier: 4,
        value: 0,
      });
    }
  }

  const out: LeanPlayer[] = [];
  for (const p of mongo) {
    const mid = p.mlbId;
    if (mid != null && consumedSourceMlbIds.has(mid)) continue;
    if (mid != null && rekeyed.has(mid)) {
      warnings.push(
        `Mongo mlbId ${mid} (${p.name}) omitted: fixture player_id ${mid} maps a different player`
      );
      continue;
    }
    out.push(p);
  }
  for (const p of rekeyed.values()) {
    out.push(p);
  }

  return { pool: out, warnings, fixtureReplayStatus };
}

async function loadCatalogFromMongo(
  fixtureById: Map<string, FixtureMeta>,
  conversionLookup: Map<string, ConvLookup>
): Promise<{ pool: LeanPlayer[]; warnings: string[]; fixtureReplayStatus: Map<string, ReplayCatalogStatus> }> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI missing");
  }
  await mongoose.connect(uri);
  try {
    const raw = await Player.find({})
      .select(PLAYER_CATALOG_LEAN_SELECT)
      .lean()
      .exec();
    const issues: string[] = [];
    const mongo = normalizeCatalogPlayers(raw, (msg) => issues.push(msg));
    if (issues.length > 0) {
      console.warn(`normalizeCatalogPlayers: ${issues.length} issue(s), showing up to 5:`);
      for (const line of issues.slice(0, 5)) console.warn(" ", line);
    }
    return mergeMongoCatalogForFixtures(mongo, fixtureById, conversionLookup);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

function poolPlayerByMlbId(pool: LeanPlayer[]): Map<string, LeanPlayer> {
  const m = new Map<string, LeanPlayer>();
  for (const p of pool) {
    if (p.mlbId != null && Number.isFinite(p.mlbId)) m.set(String(p.mlbId), p);
  }
  return m;
}

function isPoolStubRow(p: LeanPlayer | undefined): boolean {
  if (!p?._id) return false;
  return String(p._id).startsWith("fixture_stub_");
}

function missingReasonLabel(status: ReplayCatalogStatus): string {
  switch (status) {
    case "stub_missing_in_catalog":
      return "resolved_export_id_but_no_mongo_row_for_replay_stub";
    case "stub_unresolved_name":
      return "export_name_unresolved_no_real_mlb_id";
    case "synthetic_fixture_id":
      return "synthetic_placeholder_player_id_9000001_plus";
    default:
      return status;
  }
}

type MissingCatalogAgg = {
  player_id: string;
  name: string;
  position: string;
  pick_number: number | null;
  paid: number | null;
  reason_missing: string;
  replay_catalog_status: ReplayCatalogStatus;
  affected_top20: boolean;
  affected_paid_adj_miss: boolean;
};

function upsertMissingCatalog(
  m: Map<string, MissingCatalogAgg>,
  row: Omit<MissingCatalogAgg, "affected_top20" | "affected_paid_adj_miss"> & {
    affected_top20?: boolean;
    affected_paid_adj_miss?: boolean;
  }
): void {
  const prev = m.get(row.player_id);
  if (!prev) {
    m.set(row.player_id, {
      player_id: row.player_id,
      name: row.name,
      position: row.position,
      pick_number: row.pick_number,
      paid: row.paid,
      reason_missing: row.reason_missing,
      replay_catalog_status: row.replay_catalog_status,
      affected_top20: row.affected_top20 ?? false,
      affected_paid_adj_miss: row.affected_paid_adj_miss ?? false,
    });
    return;
  }
  prev.affected_top20 = prev.affected_top20 || (row.affected_top20 ?? false);
  prev.affected_paid_adj_miss = prev.affected_paid_adj_miss || (row.affected_paid_adj_miss ?? false);
  if (row.pick_number != null && (prev.pick_number == null || row.pick_number < prev.pick_number)) {
    prev.pick_number = row.pick_number;
  }
  if (row.paid != null) prev.paid = row.paid;
  if (row.name) prev.name = row.name;
  if (row.position) prev.position = row.position;
  if (row.reason_missing) prev.reason_missing = row.reason_missing;
  prev.replay_catalog_status = row.replay_catalog_status;
}

/**
 * All player_ids considered rostered at this checkpoint (auction rows + keepers + minors/taxi).
 * Matches `extractDraftedIdsAndSpend` id collection so "new picks" excludes keepers who only
 * enter `drafted_players` later with the same id.
 */
function collectAllRosterPlayerIds(n: NormalizedValuationInput): Set<string> {
  const ids = new Set<string>();
  for (const d of n.drafted_players) ids.add(d.player_id);

  const collectUnknownRows = (rows: unknown[] | undefined) => {
    for (const row of rows ?? []) {
      if (typeof row !== "object" || row == null) continue;
      const rec = row as Record<string, unknown>;
      const pid = rec.player_id;
      if (typeof pid === "string" && pid.length > 0) ids.add(pid);
    }
  };

  const collectBuckets = (buckets: NormalizedValuationInput["minors"]) => {
    if (!buckets) return;
    if (Array.isArray(buckets)) {
      for (const bucket of buckets) {
        collectUnknownRows(bucket.players as unknown[]);
      }
      return;
    }
    for (const v of Object.values(buckets)) {
      if (Array.isArray(v)) collectUnknownRows(v);
    }
  };

  if (n.pre_draft_rosters) {
    for (const rows of Object.values(n.pre_draft_rosters)) {
      collectUnknownRows(Array.isArray(rows) ? rows : []);
    }
  }
  collectBuckets(n.minors);
  collectBuckets(n.taxi);
  return ids;
}

/** Auction picks whose player_id was not on any prior roster slice (auction + keepers + minors/taxi). */
function newAuctionPicks(
  prev: NormalizedValuationInput | null,
  curr: NormalizedValuationInput
): DraftedPlayer[] {
  if (!prev) return [];
  const prevKnown = collectAllRosterPlayerIds(prev);
  return curr.drafted_players.filter((d) => !prevKnown.has(d.player_id));
}

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

type PriorMeta = {
  inflation_factor: number;
  surplus_cash?: number;
  total_surplus_mass?: number;
  fallback_reason?: string | null;
  replacement_values_by_slot_or_position?: Record<string, number>;
};

function esc(s: string): string {
  return s.replace(/\t/g, " ").replace(/\n/g, " ");
}

const FLEX_SLOTS = new Set(["UTIL", "CI", "MI", "P"]);

function slotPriorityScore(slot: string): number {
  const u = slot.toUpperCase();
  if (u === "C") return 10;
  if (u === "SS") return 20;
  if (u === "2B") return 30;
  if (u === "3B") return 40;
  if (u === "1B") return 50;
  if (u === "OF") return 60;
  if (u === "SP") return 70;
  if (u === "RP") return 80;
  if (u === "UTIL") return 90;
  if (u === "CI") return 100;
  if (u === "MI") return 110;
  if (u === "P") return 120;
  return 200;
}

function buildUserOpenSlots(n: NormalizedValuationInput, userTeamId: string): Map<string, number> {
  const open = new Map<string, number>();
  for (const rs of n.roster_slots) {
    const slot = rs.position.toUpperCase().trim();
    if (!slot || slot === "BN") continue;
    open.set(slot, (open.get(slot) ?? 0) + Math.max(0, Math.floor(rs.count ?? 0)));
  }
  const rostered = buildRosteredPlayersForSlotEngine(n).filter((p) => p.team_id === userTeamId);
  const sortedSlots = [...open.keys()].sort(
    (a, b) => slotPriorityScore(a) - slotPriorityScore(b)
  );
  for (const row of rostered) {
    const tokens = playerTokensFromDrafted(row);
    for (const slot of sortedSlots) {
      const need = open.get(slot) ?? 0;
      if (need <= 0) continue;
      if (!fitsRosterSlot(slot, tokens)) continue;
      open.set(slot, need - 1);
      break;
    }
  }
  return open;
}

function positionalNeedMultiplierForReplay(
  p: LeanPlayer,
  openSlots: Map<string, number>
): number {
  const tokens = playerTokensFromLean(p);
  const slots = [...openSlots.keys()];
  const hasOpenPrimary = slots.some((slot) => {
    const u = slot.toUpperCase();
    return (
      !FLEX_SLOTS.has(u) &&
      (openSlots.get(slot) ?? 0) > 0 &&
      fitsRosterSlot(slot, tokens)
    );
  });
  if (hasOpenPrimary) return 1.25;
  const hasOpenFlex = slots.some((slot) => {
    const u = slot.toUpperCase();
    return FLEX_SLOTS.has(u) && (openSlots.get(slot) ?? 0) > 0 && fitsRosterSlot(slot, tokens);
  });
  if (hasOpenFlex) return 1.1;
  const fitsAnyStarting = slots.some((slot) => fitsRosterSlot(slot, tokens));
  if (fitsAnyStarting) return 0.85;
  return 1.0;
}

function budgetPressureMultiplierForReplay(
  n: NormalizedValuationInput,
  userTeamId: string,
  budgetRemaining: number
): number {
  if (n.budget_by_team_id && Object.keys(n.budget_by_team_id).length > 0) {
    const map = n.budget_by_team_id;
    const userRemaining = map[userTeamId] ?? n.total_budget;
    const leagueAvg =
      Object.values(map).reduce((s, v) => s + v, 0) / Math.max(1, Object.keys(map).length);
    if (userRemaining > 1.25 * leagueAvg) return 1.15;
    if (userRemaining < 0.75 * leagueAvg) return 0.85;
    return 1.0;
  }
  const userSpent = n.drafted_players
    .filter((d) => d.team_id === userTeamId)
    .reduce((s, d) => s + (d.paid ?? 0), 0);
  const userRemaining = Math.max(0, n.total_budget - userSpent);
  const leagueAvg = budgetRemaining / Math.max(1, n.num_teams);
  if (userRemaining > 1.25 * leagueAvg) return 1.15;
  if (userRemaining < 0.75 * leagueAvg) return 0.85;
  return 1.0;
}

function replayStatusForPlayerId(
  playerId: string,
  proxyOnly: boolean,
  fixtureReplayStatus: Map<string, ReplayCatalogStatus>,
  poolByMlb: Map<string, LeanPlayer>
): ReplayCatalogStatus {
  if (proxyOnly) return "proxy_pool";
  if (fixtureReplayStatus.has(playerId)) {
    return fixtureReplayStatus.get(playerId)!;
  }
  return isPoolStubRow(poolByMlb.get(playerId)) ? "stub_missing_in_catalog" : "matched_by_id";
}

function isCatalogContaminatedPick(
  playerId: string,
  replayStatus: ReplayCatalogStatus,
  poolByMlb: Map<string, LeanPlayer>,
  proxyOnly: boolean
): boolean {
  if (proxyOnly) return false;
  if (isDataIssueReplayStatus(replayStatus)) return true;
  return isPoolStubRow(poolByMlb.get(playerId));
}

async function main(): Promise<void> {
  const proxyOnly = process.argv.includes("--proxy-only");
  const excludeStubs = process.argv.includes("--exclude-stubs");
  const hasMongo = Boolean(process.env.MONGO_URI?.trim());

  if (!proxyOnly && !hasMongo) {
    console.error(
      "MONGO_URI is not set. Load .env with MONGO_URI for Mongo-backed replay,\n" +
        "or pass --proxy-only to run the synthetic fixture catalog (clearly labeled)."
    );
    process.exit(1);
  }

  if (!existsSync(MANIFEST)) {
    console.error("Missing manifest", MANIFEST);
    process.exit(1);
  }
  if (!existsSync(FINAL_CP)) {
    console.error("Missing", FINAL_CP);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const canonicalNameById = loadCanonicalNameByPlayerId();
  const fixtureById = collectFixtureIdentityMap(manifest, canonicalNameById);
  const conversionLookup = loadConversionReport();
  const globalMisses: {
    pick: number;
    player_id: string;
    name: string;
    paid: number;
    prevAdj: number;
    delta: number;
    replay_catalog_status: ReplayCatalogStatus;
    match_method: string;
  }[] = [];

  let baselineCompare: {
    before: BaselineReplayMetrics;
    after: BaselineReplayMetrics;
    applied: { player_id: string; before: number; after: number }[];
  } | null = null;

  let pool: LeanPlayer[];
  let catalogWarnings: string[] = [];
  let fixtureReplayStatus = new Map<string, ReplayCatalogStatus>();

  if (proxyOnly) {
    console.log(
      "\n" +
        "*".repeat(72) +
        "\n  PROXY-ONLY: synthetic catalog (~920 players) from fixtures + fillers.\n" +
        "  Not Mongo. Salaries vs adjusted_value still reflect fixture paid fields.\n" +
        "*".repeat(72) +
        "\n"
    );
    for (const id of fixtureById.keys()) fixtureReplayStatus.set(id, "proxy_pool");
    pool = buildCatalogFromFixtures();
  } else {
    const loaded = await loadCatalogFromMongo(fixtureById, conversionLookup);
    pool = loaded.pool;
    catalogWarnings = loaded.warnings;
    fixtureReplayStatus = loaded.fixtureReplayStatus;
    console.log(`Mongo catalog merged for replay: ${pool.length} players.\n`);
    if (catalogWarnings.length > 0) {
      console.warn(`Catalog merge warnings (${catalogWarnings.length}), first 15:`);
      for (const w of catalogWarnings.slice(0, 15)) console.warn(" ", w);
      console.warn("");
    }
  }

  const poolByMlb = poolPlayerByMlbId(pool);

  const overridePath = parseBaselineOverridesPath(process.argv);
  if (overridePath && proxyOnly) {
    console.warn("--baseline-overrides ignored with --proxy-only (no Mongo catalog values)\n");
  } else if (overridePath && !proxyOnly) {
    if (!existsSync(overridePath)) {
      console.warn(`--baseline-overrides: file not found: ${overridePath}\n`);
    } else {
      const spec = JSON.parse(readFileSync(overridePath, "utf8")) as BaselineOverridesFile;
      console.log("\n" + "=".repeat(72));
      console.log(`BASELINE OVERRIDE FILE: ${overridePath}`);
      console.log("(Mongo Player documents unchanged; overrides apply to in-memory pool only.)\n");
      if (Array.isArray(spec.audit)) {
        console.log("--- Audit: matched_by_id rows with |paid - prev_adj| >= 15 (from audit list) ---\n");
        for (const row of spec.audit) {
          const flag = row.value_le_5_paid_ge_15 === true ? "  [mongo.value<=5 & paid>=15]" : "";
          console.log(
            `${String(row.player_id)}\t${String(row.name)}\tMongo.value=${String(row.mongo_value_before)}\tpaid=${String(row.paid)}\tprev_adj=${String(row.prev_adj)}\tpos=${String(row.position)}${flag}`
          );
        }
        const bad = spec.audit.filter((r) => r.value_le_5_paid_ge_15 === true);
        console.log(`\nClearly inconsistent (mongo value <= 5, paid >= 15): ${bad.length} player(s)`);
        for (const r of bad) {
          console.log(
            `  ${r.player_id} ${r.name}  suggested_range=${JSON.stringify(r.suggested_range)}  likely_issue=${String(r.likely_issue ?? "")}`
          );
        }
      }
      const before = await computeBaselineReplayMetrics({
        manifest,
        pool: clonePool(pool),
        conversionLookup,
        fixtureReplayStatus,
        proxyOnly,
      });
      const applied = applyBaselineOverrides(pool, spec.overrides);
      const after = await computeBaselineReplayMetrics({
        manifest,
        pool: clonePool(pool),
        conversionLookup,
        fixtureReplayStatus,
        proxyOnly,
      });
      baselineCompare = { before, after, applied };
      console.log("\n--- Dry metrics (matched_by_id new picks, |paid - prev_adj|) ---");
      console.log(
        `MAE before overrides: ${before.meanAeMatchedById.toFixed(4)} (n=${before.nMatched})  large_misses(|d|>=15): ${before.nLargeMatchedById}`
      );
      console.log(
        `MAE after overrides:  ${after.meanAeMatchedById.toFixed(4)} (n=${after.nMatched})  large_misses(|d|>=15): ${after.nLargeMatchedById}`
      );
      const maeDrop = before.meanAeMatchedById - after.meanAeMatchedById;
      console.log(
        `MAE delta (before - after): ${Number.isFinite(maeDrop) ? maeDrop.toFixed(4) : "n/a"}  |  large-miss delta: ${before.nLargeMatchedById - after.nLargeMatchedById}`
      );
      if (applied.length) {
        console.log("\nOverrides applied to pool (LeanPlayer.value):");
        for (const a of applied) {
          console.log(`  ${a.player_id}: ${a.before} -> ${a.after}`);
        }
      }
      console.log("\nProceeding with full verbose replay using overridden pool.\n");
    }
  }

  const missingCatalog = new Map<string, MissingCatalogAgg>();
  const joinHist = new Map<string, number>();
  for (const st of fixtureReplayStatus.values()) {
    joinHist.set(st, (joinHist.get(st) ?? 0) + 1);
  }
  console.log("--- Replay fixture → catalog join (all roster identities in checkpoints) ---");
  console.log(`fixture_identity_keys: ${fixtureReplayStatus.size}`);
  console.log(`join_status_counts: ${JSON.stringify(Object.fromEntries(joinHist))}`);
  if (excludeStubs) {
    console.log(
      "Mode --exclude-stubs: stub/synthetic picks are omitted from median/top-10 summaries and from the largest-|delta| footer (TSV still lists every pick).\n"
    );
  }

  let excludedPickRowsFromSummaries = 0;

  let prevNorm: NormalizedValuationInput | null = null;
  const prevAdj = new Map<string, number>();
  const prevRecommended = new Map<string, number>();
  let priorMeta: PriorMeta | null = null;
  const globalAbsAdj: number[] = [];
  const globalAbsRecommended: number[] = [];

  for (const step of manifest.steps) {
    const reqPath = path.join(ROOT, step.request_path);
    console.log("=".repeat(72));
    console.log("CHECKPOINT:", step.label);
    console.log("request:", step.request_path);
    if (!existsSync(reqPath)) {
      console.log("MISSING FILE\n");
      continue;
    }
    const raw = JSON.parse(readFileSync(reqPath, "utf8")) as Record<string, unknown>;
    const merged = {
      ...raw,
      inflation_model: raw.inflation_model ?? "replacement_slots_v2",
    };
    const parsed = parseValuationRequest(merged);
    if (!parsed.success) {
      console.log("PARSE FAIL", parsed.errors.slice(0, 3), "\n");
      continue;
    }
    const n = parsed.normalized;
    const out = executeValuationWorkflow(pool, n, {});
    if (!out.ok) {
      console.log("WORKFLOW FAIL", out.issues, "\n");
      prevNorm = n;
      prevAdj.clear();
      prevRecommended.clear();
      priorMeta = null;
      continue;
    }
    const res = out.response;
    console.log(
      `inflation_model=${res.inflation_model} factor=${res.inflation_factor} raw=${res.inflation_raw} bounded=${res.inflation_bounded_by}`
    );
    console.log(
      `budget_rem=${res.total_budget_remaining} pool_val=${res.pool_value_remaining} players_rem=${res.players_remaining}`
    );
    if (res.inflation_model === "replacement_slots_v2") {
      console.log(
        `remaining_slots=${res.remaining_slots} min_bid=${res.min_bid} surplus_cash=${res.surplus_cash} total_surplus_mass=${res.total_surplus_mass} draftable_pool_size=${res.draftable_pool_size} fallback_reason=${JSON.stringify(res.fallback_reason)}`
      );
    }

    const picks = newAuctionPicks(prevNorm, n);
    const replPrior = priorMeta?.replacement_values_by_slot_or_position;

    if (picks.length > 0) {
      const absErrs: number[] = [];
      const absErrsRecommended: number[] = [];
      const rows: {
        pick: number;
        player_id: string;
        name: string;
        pos: string;
        team_id: string;
        paid: number;
        prevAdj: number | null;
        delta: number | null;
        prevRecommended: number | null;
        deltaRecommended: number | null;
        repl: string;
        infl: number;
        surp: string;
        mass: string;
        fb: string;
        replay_catalog_status: ReplayCatalogStatus;
        match_method: string;
        catalog_contaminated: boolean;
      }[] = [];

      for (const p of picks) {
        const conv = conversionLookup.get(p.player_id);
        const match_method = proxyOnly ? "proxy_pool" : conv?.match_method ?? "unknown";
        const replay_catalog_status = replayStatusForPlayerId(
          p.player_id,
          proxyOnly,
          fixtureReplayStatus,
          poolByMlb
        );
        const catalog_contaminated = isCatalogContaminatedPick(
          p.player_id,
          replay_catalog_status,
          poolByMlb,
          proxyOnly
        );
        if (excludeStubs && catalog_contaminated) excludedPickRowsFromSummaries += 1;

        const adj0 = prevAdj.get(p.player_id);
        const rec0 = prevRecommended.get(p.player_id);
        const paid = p.paid ?? 0;
        const prevInfl = priorMeta?.inflation_factor ?? NaN;
        const sc = priorMeta?.surplus_cash;
        const tm = priorMeta?.total_surplus_mass;
        const fb = priorMeta?.fallback_reason ?? "";
        const r = replacementForPosition(replPrior, p.position);
        const replStr = r ? `${r.key}=${r.value.toFixed(2)}` : "-";

        let delta: number | null = null;
        if (adj0 != null && Number.isFinite(adj0)) {
          delta = paid - adj0;
          if (Number.isFinite(paid) && !(excludeStubs && catalog_contaminated)) {
            absErrs.push(Math.abs(delta));
            globalAbsAdj.push(Math.abs(delta));
          }
        }
        let deltaRecommended: number | null = null;
        if (rec0 != null && Number.isFinite(rec0)) {
          deltaRecommended = paid - rec0;
          if (Number.isFinite(paid) && !(excludeStubs && catalog_contaminated)) {
            absErrsRecommended.push(Math.abs(deltaRecommended));
            globalAbsRecommended.push(Math.abs(deltaRecommended));
          }
        }

        rows.push({
          pick: p.pick_number ?? -1,
          player_id: p.player_id,
          name: p.name,
          pos: p.position,
          team_id: p.team_id,
          paid,
          prevAdj: adj0 ?? null,
          delta,
          prevRecommended: rec0 ?? null,
          deltaRecommended,
          repl: replStr,
          infl: prevInfl,
          surp: sc != null && Number.isFinite(sc) ? sc.toFixed(2) : "-",
          mass: tm != null && Number.isFinite(tm) ? tm.toFixed(2) : "-",
          fb: fb == null ? "" : String(fb),
          replay_catalog_status,
          match_method,
          catalog_contaminated,
        });

        if (catalog_contaminated) {
          upsertMissingCatalog(missingCatalog, {
            player_id: p.player_id,
            name: p.name,
            position: p.position,
            pick_number: p.pick_number ?? null,
            paid,
            reason_missing: missingReasonLabel(replay_catalog_status),
            replay_catalog_status,
          });
        }

        if (delta != null && adj0 != null && Math.abs(delta) >= 15) {
          globalMisses.push({
            pick: p.pick_number ?? -1,
            player_id: p.player_id,
            name: p.name,
            paid,
            prevAdj: adj0,
            delta,
            replay_catalog_status,
            match_method,
          });
          if (catalog_contaminated) {
            upsertMissingCatalog(missingCatalog, {
              player_id: p.player_id,
              name: p.name,
              position: p.position,
              pick_number: p.pick_number ?? null,
              paid,
              reason_missing: missingReasonLabel(replay_catalog_status),
              replay_catalog_status,
              affected_paid_adj_miss: true,
            });
          }
        }
      }

      const countStatus = (pred: (s: ReplayCatalogStatus) => boolean) =>
        rows.filter((r) => pred(r.replay_catalog_status)).length;
      const unresolvedPicks = rows.filter((r) => isDataIssueReplayStatus(r.replay_catalog_status)).length;
      const resolvedPicks = rows.length - unresolvedPicks;
      const missingCatalogNewPicks = countStatus((s) => s === "stub_missing_in_catalog");

      console.log(
        "\nNew picks (prior-step adjusted_value vs paid; market columns = prior checkpoint v2 state):"
      );
      console.log(
        [
          "pick",
          "player_id",
          "player",
          "pos",
          "team_id",
          "paid",
          "prev_adj",
          "delta(paid-prev_adj)",
          "prev_recommended_bid",
          "delta(paid-prev_recommended)",
          "replay_catalog_status",
          "match_method",
          "repl_slot/value",
          "inflation_factor",
          "surplus_cash",
          "total_surplus_mass",
          "fallback_reason",
        ].join("\t")
      );
      for (const r of rows) {
        console.log(
          [
            r.pick,
            r.player_id,
            esc(r.name),
            esc(r.pos),
            r.team_id,
            r.paid.toFixed(2),
            r.prevAdj != null ? r.prevAdj.toFixed(2) : "-",
            r.delta != null ? r.delta.toFixed(2) : "-",
            r.prevRecommended != null ? r.prevRecommended.toFixed(2) : "-",
            r.deltaRecommended != null ? r.deltaRecommended.toFixed(2) : "-",
            r.replay_catalog_status,
            r.match_method,
            r.repl,
            Number.isFinite(r.infl) ? r.infl.toFixed(4) : "-",
            r.surp,
            r.mass,
            esc(r.fb),
          ].join("\t")
        );
      }

      console.log("\n--- Replay catalog diagnostics (this checkpoint, new auction picks) ---");
      console.log(`total_new_picks: ${picks.length}`);
      console.log(`resolved_picks: ${resolvedPicks}`);
      console.log(`unresolved_picks: ${unresolvedPicks}`);
      console.log(`missing_catalog_rows (replay status): ${missingCatalogNewPicks}`);
      console.log(
        `by_status: matched_by_id=${countStatus((s) => s === "matched_by_id")} matched_by_name=${countStatus((s) => s === "matched_by_name")} stub_missing_in_catalog=${countStatus((s) => s === "stub_missing_in_catalog")} stub_unresolved_name=${countStatus((s) => s === "stub_unresolved_name")} synthetic_fixture_id=${countStatus((s) => s === "synthetic_fixture_id")} proxy_pool=${countStatus((s) => s === "proxy_pool")}`
      );
      const stubDrafted = rows.filter((r) => r.catalog_contaminated).length;
      console.log(`stubs_among_new_auction_picks: ${stubDrafted}`);

      const valid = rows.filter(
        (r) =>
          r.prevAdj != null &&
          r.delta != null &&
          !(excludeStubs && r.catalog_contaminated)
      );
      const mae = median(absErrs);
      const meanAe = mean(absErrs);
      const meanRecommendedAe = mean(absErrsRecommended);
      console.log(`\n--- Checkpoint summary (new picks only, n=${valid.length}) ---`);
      if (excludeStubs) {
        console.log(
          `(summary uses ${valid.length} of ${rows.length} picks after excluding catalog-contaminated rows)`
        );
      }
      console.log(`median |paid - prev_adj|: ${Number.isFinite(mae) ? mae.toFixed(4) : "n/a"}`);
      console.log(`mean |paid - prev_adj|: ${Number.isFinite(meanAe) ? meanAe.toFixed(4) : "n/a"}`);
      console.log(
        `mean |paid - prev_recommended_bid|: ${Number.isFinite(meanRecommendedAe) ? meanRecommendedAe.toFixed(4) : "n/a"}`
      );

      const over = [...valid]
        .filter((r) => r.prevAdj! - r.paid > 0)
        .sort((a, b) => (b.prevAdj! - b.paid) - (a.prevAdj! - a.paid))
        .slice(0, 10);
      const under = [...valid]
        .filter((r) => r.paid - r.prevAdj! > 0)
        .sort((a, b) => (b.paid - b.prevAdj!) - (a.paid - a.prevAdj!))
        .slice(0, 10);
      console.log(
        "\nTop 10 model > auction (prev_adj > paid; gap = prev_adj - paid, largest gap first):"
      );
      if (over.length === 0) {
        console.log("  (none — every new pick cleared at or above prior adjusted_value)");
      } else {
        for (const r of over) {
          console.log(
            `  pick ${r.pick} ${r.name} prev_adj=${r.prevAdj!.toFixed(2)} paid=${r.paid.toFixed(2)} gap=${(r.prevAdj! - r.paid).toFixed(2)} replay=${r.replay_catalog_status}`
          );
        }
      }
      console.log(
        "\nTop 10 auction > model (paid > prev_adj; gap = paid - prev_adj, largest gap first):"
      );
      if (under.length === 0) {
        console.log("  (none — no new pick paid more than prior adjusted_value)");
      } else {
        for (const r of under) {
          console.log(
            `  pick ${r.pick} ${r.name} prev_adj=${r.prevAdj!.toFixed(2)} paid=${r.paid.toFixed(2)} gap=${(r.paid - r.prevAdj!).toFixed(2)} replay=${r.replay_catalog_status}`
          );
        }
      }
    } else {
      console.log("\nNew picks since prior step: 0 (pre_draft or unchanged roster)");
    }

    if (res.replacement_values_by_slot_or_position) {
      console.log(
        "\nreplacement_values_by_slot_or_position (this checkpoint):\n",
        JSON.stringify(res.replacement_values_by_slot_or_position, null, 2)
      );
    }

    const topAvail = [...res.valuations]
      .sort((a, b) => b.adjusted_value - a.adjusted_value)
      .slice(0, TOP_AVAIL_N);
    let stubsInTopAvail = 0;
    console.log(
      `\nTop ${TOP_AVAIL_N} available players by adjusted_value (this checkpoint; [CATALOG_STUB] = zero-baseline stub row):`
    );
    for (const r of topAvail) {
      const st = replayStatusForPlayerId(r.player_id, proxyOnly, fixtureReplayStatus, poolByMlb);
      const contaminated = isCatalogContaminatedPick(r.player_id, st, poolByMlb, proxyOnly);
      if (contaminated) {
        stubsInTopAvail += 1;
        upsertMissingCatalog(missingCatalog, {
          player_id: r.player_id,
          name: r.name,
          position: r.position,
          pick_number: null,
          paid: null,
          reason_missing: missingReasonLabel(st),
          replay_catalog_status: st,
          affected_top20: true,
        });
      }
      const tag = contaminated ? " [CATALOG_STUB]" : "";
      console.log(
        `  ${r.player_id} ${r.name} ${r.position} baseline=${r.baseline_value.toFixed(2)} adj=${r.adjusted_value.toFixed(2)} replay=${st}${tag}`
      );
    }
    const pctStubTop = (stubsInTopAvail / TOP_AVAIL_N) * 100;
    console.log(
      `\n--- Top-${TOP_AVAIL_N} contamination (catalog / data) ---\n` +
        `stubs_in_top_${TOP_AVAIL_N}_adjusted: ${stubsInTopAvail}\n` +
        `pct_top_${TOP_AVAIL_N}_contaminated_by_stubs: ${pctStubTop.toFixed(1)}%`
    );

    const teamRows = res.valuations.filter(
      (v) =>
        typeof v.team_adjusted_value === "number" &&
        Number.isFinite(v.team_adjusted_value)
    );
    if (teamRows.length > 0) {
      const userTeamId = res.user_team_id_used?.trim() || "team_1";
      const openSlots = buildUserOpenSlots(n, userTeamId);
      const budgetMult = budgetPressureMultiplierForReplay(
        n,
        userTeamId,
        res.total_budget_remaining
      );
      const posMultDist = new Map<string, number>();
      const budgetMultDist = new Map<string, number>();
      const combinedDist = new Map<string, number>();
      const deltas = teamRows.map((v) => v.team_adjusted_value! - v.adjusted_value);
      const avgDelta = mean(deltas);
      const bands = { boost: 0, flat: 0, discount: 0 };
      for (const d of deltas) {
        if (d > 0.01) bands.boost += 1;
        else if (d < -0.01) bands.discount += 1;
        else bands.flat += 1;
      }

      const detailed = teamRows.map((v) => {
        const lp = poolByMlb.get(v.player_id);
        const posMult = lp ? positionalNeedMultiplierForReplay(lp, openSlots) : 1.0;
        const posKey = posMult.toFixed(2);
        const budKey = budgetMult.toFixed(2);
        const combinedKey = `${posKey}x${budKey}`;
        posMultDist.set(posKey, (posMultDist.get(posKey) ?? 0) + 1);
        budgetMultDist.set(budKey, (budgetMultDist.get(budKey) ?? 0) + 1);
        combinedDist.set(combinedKey, (combinedDist.get(combinedKey) ?? 0) + 1);
        return {
          player_id: v.player_id,
          name: v.name,
          position: v.position,
          adjusted_value: v.adjusted_value,
          team_adjusted_value: v.team_adjusted_value!,
          delta: v.team_adjusted_value! - v.adjusted_value,
          posMult,
          budgetMult,
          combinedKey,
        };
      });
      const topBoost = [...detailed]
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 10);
      const topDiscount = [...detailed]
        .sort((a, b) => a.delta - b.delta)
        .slice(0, 10);
      const asObj = (m: Map<string, number>) => Object.fromEntries(
        [...m.entries()].sort((a, b) => Number(a[0].split("x")[0]) - Number(b[0].split("x")[0]))
      );
      console.log(
        "\n--- Team-adjusted diagnostics (presentation layer) ---\n" +
          `avg(team_adjusted - adjusted): ${avgDelta.toFixed(4)}\n` +
          `distribution: boost=${bands.boost} flat=${bands.flat} discount=${bands.discount}\n` +
          `positional_need_multiplier distribution: ${JSON.stringify(asObj(posMultDist))}\n` +
          `budget_pressure_multiplier distribution: ${JSON.stringify(asObj(budgetMultDist))}\n` +
          `combined multiplier distribution: ${JSON.stringify(asObj(combinedDist))}`
      );
      console.log("\nTop 10 largest team_adjusted_value boosts:");
      for (const r of topBoost) {
        console.log(
          `  ${r.player_id} ${r.name} ${r.position} adj=${r.adjusted_value.toFixed(2)} team_adj=${r.team_adjusted_value.toFixed(2)} delta=${r.delta.toFixed(2)} mult=${r.combinedKey}`
        );
      }
      console.log("\nTop 10 largest team_adjusted_value discounts:");
      for (const r of topDiscount) {
        console.log(
          `  ${r.player_id} ${r.name} ${r.position} adj=${r.adjusted_value.toFixed(2)} team_adj=${r.team_adjusted_value.toFixed(2)} delta=${r.delta.toFixed(2)} mult=${r.combinedKey}`
        );
      }
    }

    priorMeta = {
      inflation_factor: res.inflation_factor,
      surplus_cash: res.surplus_cash,
      total_surplus_mass: res.total_surplus_mass,
      fallback_reason: res.fallback_reason,
      replacement_values_by_slot_or_position: res.replacement_values_by_slot_or_position,
    };

    prevAdj.clear();
    prevRecommended.clear();
    for (const r of res.valuations) {
      prevAdj.set(r.player_id, r.adjusted_value);
      if (typeof r.recommended_bid === "number" && Number.isFinite(r.recommended_bid)) {
        prevRecommended.set(r.player_id, r.recommended_bid);
      }
    }
    prevNorm = n;
    console.log("");
  }

  console.log("Done.");

  mkdirSync(path.dirname(MISSING_CATALOG_REPORT), { recursive: true });
  const missingRows = [...missingCatalog.values()].sort((a, b) => a.player_id.localeCompare(b.player_id));
  writeFileSync(
    MISSING_CATALOG_REPORT,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        top_avail_n: TOP_AVAIL_N,
        rows: missingRows,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\nWrote missing-catalog report (${missingRows.length} row(s)): ${MISSING_CATALOG_REPORT}`);

  if (excludeStubs) {
    const excludedLarge = globalMisses.filter((m) => isDataIssueReplayStatus(m.replay_catalog_status)).length;
    console.log(
      `\n--exclude-stubs summary: ${excludedPickRowsFromSummaries} new-pick row(s) (cumulative across checkpoints) omitted from median/mean and top-10 tables; ` +
        `${excludedLarge} |delta|>=15 miss row(s) omitted from largest-delta footer (full TSV above still lists every pick).`
    );
  }

  if (existsSync(CONVERSION_REPORT)) {
    try {
      const rep = JSON.parse(readFileSync(CONVERSION_REPORT, "utf8")) as ConversionReportFile;
      const stub = rep.summary?.stub_unresolved_count ?? rep.entries?.filter((e) => e.catalog_match_status === "stub").length ?? 0;
      const methods = new Map<string, number>();
      for (const e of rep.entries ?? []) {
        const k = e.match_method ?? "unknown";
        methods.set(k, (methods.get(k) ?? 0) + 1);
      }
      console.log("\n" + "=".repeat(72));
      console.log("EXPORT / CONVERSION SUMMARY (conversion-match-report.json)");
      console.log(`stub_unresolved_count: ${stub}`);
      console.log(`match_method counts: ${JSON.stringify(Object.fromEntries(methods))}`);
      if (rep.pick_gaps?.length) {
        console.log(`pick_gaps_in_sheet (${rep.pick_gaps.length}): ${rep.pick_gaps.slice(0, 30).join(",")}${rep.pick_gaps.length > 30 ? ",…" : ""}`);
      } else {
        console.log("pick_gaps_in_sheet: none");
      }
      if (rep.duplicate_pick_numbers?.length) {
        console.log(`duplicate_pick_numbers: ${rep.duplicate_pick_numbers.join(",")}`);
      }
    } catch {
      /* ignore */
    }
  }

  if (globalMisses.length > 0) {
    const missesForPrint = excludeStubs
      ? globalMisses.filter((m) => !isDataIssueReplayStatus(m.replay_catalog_status))
      : globalMisses;
    const stubMisses = globalMisses.filter((m) => isDataIssueReplayStatus(m.replay_catalog_status)).length;
    const byAbs = [...missesForPrint].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);
    console.log("\nLargest |paid - prev_adj| among new picks (|delta|>=15, all checkpoints combined):");
    console.log(
      `(rows with stub/synthetic catalog: ${stubMisses} of ${globalMisses.length} total large-miss events${
        excludeStubs ? "; footer lists non-stub misses only" : ""
      })`
    );
    if (byAbs.length === 0) {
      console.log("  (none after filters)");
    } else {
      for (const m of byAbs) {
        console.log(
          `  pick ${m.pick} id=${m.player_id} ${m.name} paid=${m.paid.toFixed(2)} prev_adj=${m.prevAdj.toFixed(2)} delta=${m.delta.toFixed(2)} replay=${m.replay_catalog_status} method=${m.match_method}`
        );
      }
    }
  }

  if (globalAbsAdj.length > 0 || globalAbsRecommended.length > 0) {
    console.log("\n" + "=".repeat(72));
    console.log("PAID ERROR COMPARISON (new picks, replay filters applied)");
    const maeAdj = mean(globalAbsAdj);
    const maeRec = mean(globalAbsRecommended);
    console.log(
      `mean |paid - prev_adj|: ${Number.isFinite(maeAdj) ? maeAdj.toFixed(4) : "n/a"}`
    );
    console.log(
      `mean |paid - prev_recommended_bid|: ${Number.isFinite(maeRec) ? maeRec.toFixed(4) : "n/a"}`
    );
    if (Number.isFinite(maeAdj) && Number.isFinite(maeRec)) {
      console.log(
        `recommended_bid MAE improvement: ${(maeAdj - maeRec).toFixed(4)} (positive means lower error)`
      );
    }
  }

  const anyTop20Stub = missingRows.some((r) => r.affected_top20);
  const stubLargeMiss = globalMisses.filter((m) => isDataIssueReplayStatus(m.replay_catalog_status)).length;
  const cleanLargeMiss = globalMisses.length - stubLargeMiss;
  console.log("\n" + "=".repeat(72));
  console.log("REPLAY READINESS (diagnostic only — valuation math unchanged)");
  console.log(
    `Unique catalog/data problem player_ids (missing report): ${missingRows.length}. ` +
      `Large paid-vs-adjusted misses (|delta|>=15): ${cleanLargeMiss} likely model/signal on clean catalog rows, ` +
      `${stubLargeMiss} on stub/synthetic rows (baseline/catalog issue).`
  );
  console.log(
    `Top-${TOP_AVAIL_N} lists showed at least one catalog stub in some checkpoint: ${anyTop20Stub ? "yes (see [CATALOG_STUB] lines)" : "no"}.`
  );
  console.log(
    "replacement_slots_v2: use this split to decide whether misses are trustworthy; refresh Mongo/catalog coverage if stub misses dominate."
  );

  if (baselineCompare) {
    const maeDrop = baselineCompare.before.meanAeMatchedById - baselineCompare.after.meanAeMatchedById;
    const largeMatchedVerbose = globalMisses.filter(
      (m) => m.replay_catalog_status === "matched_by_id" && Math.abs(m.delta) >= 15
    ).length;
    console.log("\n" + "=".repeat(72));
    console.log("BASELINE OVERRIDE SUMMARY (replay-only; DB and v2 math unchanged)");
    console.log(
      `MAE (matched_by_id new picks) dropped by ${Number.isFinite(maeDrop) ? maeDrop.toFixed(4) : "n/a"} absolute vs dry-run baseline (before ${baselineCompare.before.meanAeMatchedById.toFixed(4)} -> after ${baselineCompare.after.meanAeMatchedById.toFixed(4)}).`
    );
    console.log(
      `Large |paid-prev_adj| (>=15) matched_by_id: dry-run ${baselineCompare.before.nLargeMatchedById} -> ${baselineCompare.after.nLargeMatchedById}; verbose footer count=${largeMatchedVerbose} (should match dry-run after).`
    );
    console.log(
      "Interpretation: error reduction above is purely catalog `value` input; any remaining large misses on stars (Harper, Olson, …) are not fixed by the five low-dollar patches and still reflect v2 surplus/replacement vs auction, not a systematic v2 bug."
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
