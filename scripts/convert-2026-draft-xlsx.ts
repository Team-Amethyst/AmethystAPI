/**
 * Converts instructor 2026Draft.xlsx → five valuation checkpoint JSON files.
 * Resolves canonical MLB player_id (Mongo / MLB Stats API) with abbreviated-name
 * matching; writes conversion-match-report.json for replay diagnostics.
 *
 * Usage: pnpm run convert-2026-draft -- [path/to/2026Draft.xlsx] [--skip-mlb-search]
 *
 * See docs/draft-2026-xlsx-mapping.md
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import type { CellObject } from "xlsx";
import mongoose from "mongoose";
import Player from "../src/models/Player";
import {
  type CatalogRow,
  type ConversionReportEntry,
  type MatchMethod,
  type Resolution,
  resolveAgainstCatalog,
  resolveViaMlbSearch,
  rosterIdentityKey,
  sanitizeSheetPlayerName,
  nextSyntheticMlbId,
} from "./lib/draftPlayerIdResolve";

type Drafted = {
  player_id: string;
  name: string;
  position: string;
  team: string;
  team_id: string;
  paid?: number;
  pick_number?: number;
  is_keeper?: boolean;
};

type TeamBucket = { team_id: string; players: Drafted[] };

const ROOT = path.join(__dirname, "..");
const OUT_TEST = path.join(ROOT, "test-fixtures", "player-api", "checkpoints");
const OUT_PUBLIC = path.join(ROOT, "public", "fixtures", "checkpoints");

const CHECKPOINTS = [0, 10, 50, 100, 130] as const;

const DEFAULT_ROSTER_SLOTS = [
  { position: "C", count: 1 },
  { position: "1B", count: 1 },
  { position: "2B", count: 1 },
  { position: "3B", count: 1 },
  { position: "SS", count: 1 },
  { position: "OF", count: 5 },
  { position: "CI", count: 1 },
  { position: "MI", count: 1 },
  { position: "UTIL", count: 1 },
  { position: "P", count: 9 },
];

const DEFAULT_SCORING = [
  { name: "R", type: "batting" as const },
  { name: "HR", type: "batting" as const },
  { name: "RBI", type: "batting" as const },
  { name: "SB", type: "batting" as const },
  { name: "AVG", type: "batting" as const },
  { name: "W", type: "pitching" as const },
  { name: "SV", type: "pitching" as const },
  { name: "ERA", type: "pitching" as const },
  { name: "WHIP", type: "pitching" as const },
  { name: "K", type: "pitching" as const },
];

function cellStr(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "object" && "w" in (c as CellObject) && (c as CellObject).w != null) {
    return String((c as CellObject).w);
  }
  return String(c).trim();
}

function parseMoney(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const s = cellStr(raw).replace(/[$,\s]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function teamIdFromLabel(label: string): string | null {
  const m = /^Team\s+([A-Za-z])/i.exec(label.trim());
  if (!m) return null;
  return `team_${m[1].toLowerCase()}`;
}

function parsePreDraftBudgets(row0: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const cell of row0) {
    const s = cellStr(cell);
    const m = /^Team\s+([A-Za-z])\s+\$(\d+)/i.exec(s);
    if (m) {
      map.set(`team_${m[1].toLowerCase()}`, Number(m[2]));
    }
  }
  return map;
}

function parsePreDraftRoster(rows: unknown[][]): TeamBucket[] {
  if (rows.length < 2) return [];
  const row0 = rows[0] ?? [];
  const blocks: { team_id: string; startCol: number }[] = [];
  for (let c = 0; c < row0.length; c++) {
    const s = cellStr(row0[c]);
    const tid = teamIdFromLabel(s);
    if (tid) blocks.push({ team_id: tid, startCol: c });
  }
  const byTeam = new Map<string, Drafted[]>();
  for (const b of blocks) {
    byTeam.set(b.team_id, []);
  }
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    for (const b of blocks) {
      const pos = cellStr(row[b.startCol]);
      const name = cellStr(row[b.startCol + 1]);
      if (!name) continue;
      if (/^team\s+[a-z]$/i.test(name.trim())) continue;
      const salRaw = row[b.startCol + 3];
      const paid = parseMoney(salRaw);
      byTeam.get(b.team_id)!.push({
        player_id: "",
        name,
        position: pos || "UTIL",
        team: "UNK",
        team_id: b.team_id,
        paid,
        is_keeper: true,
      });
    }
  }
  return [...byTeam.entries()].map(([team_id, players]) => ({ team_id, players }));
}

function parseMinors(rows: unknown[][]): TeamBucket[] {
  if (rows.length < 2) return [];
  const row0 = rows[0] ?? [];
  const teamCols: { team_id: string; nameCol: number }[] = [];
  for (let c = 0; c < row0.length; c++) {
    const tid = teamIdFromLabel(cellStr(row0[c]));
    if (tid) teamCols.push({ team_id: tid, nameCol: c });
  }
  const byTeam = new Map<string, Drafted[]>();
  for (const t of teamCols) byTeam.set(t.team_id, []);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    for (const t of teamCols) {
      const name = cellStr(row[t.nameCol]);
      if (!name) continue;
      if (/^team\s+[a-z]$/i.test(name.trim())) continue;
      byTeam.get(t.team_id)!.push({
        player_id: "",
        name,
        position: "UTIL",
        team: "UNK",
        team_id: t.team_id,
        paid: 0,
      });
    }
  }
  return [...byTeam.entries()].map(([team_id, players]) => ({ team_id, players }));
}

function parseDraft(rows: unknown[][]): {
  picks: {
    pick: number;
    player: string;
    position: string;
    mlbTeam: string;
    wonTeamId: string;
    salary: number;
  }[];
  warnings: string[];
  pickGaps: number[];
  duplicatePickNumbers: number[];
} {
  const picks: {
    pick: number;
    player: string;
    position: string;
    mlbTeam: string;
    wonTeamId: string;
    salary: number;
  }[] = [];
  const warnings: string[] = [];
  const seenPick = new Map<number, number>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const pick = Number(row[0]);
    if (!Number.isFinite(pick)) continue;
    const won = cellStr(row[5]);
    const tid = teamIdFromLabel(won);
    if (!tid) {
      warnings.push(
        `Draft row ${r + 1}: pick ${pick} skipped — could not parse winning team from "${won}" (expected "Team X")`
      );
      continue;
    }
    const salary = parseMoney(row[6]);
    picks.push({
      pick,
      player: cellStr(row[2]),
      position: cellStr(row[3]) || "UTIL",
      mlbTeam: cellStr(row[4]) || "UNK",
      wonTeamId: tid,
      salary,
    });
    seenPick.set(pick, (seenPick.get(pick) ?? 0) + 1);
  }
  picks.sort((a, b) => a.pick - b.pick);

  const duplicatePickNumbers: number[] = [];
  for (const [pn, count] of seenPick) {
    if (count > 1) {
      duplicatePickNumbers.push(pn);
      warnings.push(
        `DUPLICATE_PICK|pick=${pn}|rows=${count}|detail=Excel has multiple Draft rows for the same pick number; last row wins after sort`
      );
    }
  }

  const pickGaps: number[] = [];
  if (picks.length > 0) {
    const maxP = picks[picks.length - 1]!.pick;
    const have = new Set(picks.map((p) => p.pick));
    for (let i = 1; i < maxP; i++) {
      if (!have.has(i)) pickGaps.push(i);
    }
    if (pickGaps.length) {
      warnings.push(
        `PICK_GAPS|missing=${pickGaps.slice(0, 40).join(",")}${pickGaps.length > 40 ? ",…" : ""}|max_pick_in_sheet=${maxP}|detail=No Draft row for those pick numbers (blank rows or parse failures)`
      );
    }
  }

  return { picks, warnings, pickGaps, duplicatePickNumbers };
}

type ResolveTask = {
  /** Longest raw spelling seen for this identity (prefer full name over abbrev). */
  rawName: string;
  teamHint: string;
  context: ConversionReportEntry["context"];
  pick?: number;
};

async function loadMongoCatalog(): Promise<CatalogRow[]> {
  const uri = process.env.MONGO_URI?.trim();
  if (!uri) return [];
  await mongoose.connect(uri);
  try {
    const docs = await Player.find({ mlbId: { $exists: true, $ne: null } })
      .select("mlbId name team")
      .lean()
      .exec();
    const rows: CatalogRow[] = [];
    for (const d of docs as { mlbId?: number; name?: string; team?: string }[]) {
      const mid = Number(d.mlbId);
      if (!Number.isFinite(mid)) continue;
      rows.push({
        mlbId: mid,
        name: String(d.name ?? ""),
        team: String(d.team ?? ""),
      });
    }
    return rows;
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveAllTasks(
  tasks: Map<string, ResolveTask>,
  catalog: CatalogRow[],
  skipMlbSearch: boolean,
  globalWarnings: string[]
): Promise<{
  idByIdentity: Map<string, string>;
  entries: ConversionReportEntry[];
}> {
  const idByIdentity = new Map<string, string>();
  const entries: ConversionReportEntry[] = [];
  const synth = { n: 0 };

  for (const [ik, task] of tasks) {
    const sheetSan = sanitizeSheetPlayerName(task.rawName);
    let res: Resolution | null = null;
    if (catalog.length) {
      res = resolveAgainstCatalog(task.rawName, task.teamHint, catalog);
    }
    if (!res && !skipMlbSearch) {
      await sleep(110);
      res = await resolveViaMlbSearch(task.rawName, task.teamHint);
    }

    let mlbId: number;
    let method: MatchMethod;
    let detail: string;
    let canonical: string | undefined;
    let status: "resolved" | "stub";

    if (res) {
      mlbId = res.mlbId;
      method = res.method;
      detail = res.detail;
      canonical = res.canonicalName;
      status = "resolved";
    } else {
      mlbId = nextSyntheticMlbId(synth);
      method = "synthetic_unresolved";
      status = "stub";
      detail = `no Mongo match and ${skipMlbSearch ? "MLB search skipped (--skip-mlb-search)" : "MLB search returned no people"}`;
      globalWarnings.push(
        `UNRESOLVED|identity_key=${ik}|sheet_name=${JSON.stringify(task.rawName)}|sanitized=${JSON.stringify(sheetSan)}|team_hint=${JSON.stringify(task.teamHint)}|context=${task.context}|pick=${task.pick ?? ""}|detail=${detail}`
      );
    }

    const player_id = String(mlbId);
    idByIdentity.set(ik, player_id);

    entries.push({
      player_id,
      sheet_name: task.rawName,
      canonical_name: canonical,
      team_hint: task.teamHint || "",
      match_method: method,
      catalog_match_status: status,
      detail,
      pick_number: task.pick,
      context: task.context,
    });
  }

  return { idByIdentity, entries };
}

function collectTasks(
  preBuckets: TeamBucket[],
  minorBuckets: TeamBucket[],
  picks: { pick: number; player: string; mlbTeam: string }[]
): Map<string, ResolveTask> {
  const tasks = new Map<string, ResolveTask>();

  const add = (rawName: string, teamHint: string, context: ResolveTask["context"], pick?: number) => {
    if (!rawName.trim()) return;
    const ik = rosterIdentityKey(rawName);
    if (!ik) return;
    const hint = (teamHint || "").trim();
    const existing = tasks.get(ik);
    if (!existing) {
      tasks.set(ik, {
        rawName: rawName.trim(),
        teamHint: hint === "UNK" ? "" : hint,
        context,
        pick,
      });
      return;
    }
    if (rawName.trim().length > existing.rawName.length) {
      existing.rawName = rawName.trim();
    }
    if (hint && hint !== "UNK" && (!existing.teamHint || existing.teamHint === "")) {
      existing.teamHint = hint;
    }
    if (pick != null && (existing.pick == null || pick < existing.pick)) {
      existing.pick = pick;
    }
  };

  for (const b of preBuckets) {
    for (const p of b.players) {
      add(p.name, "", "keeper");
    }
  }
  for (const b of minorBuckets) {
    for (const p of b.players) {
      add(p.name, "", "minors");
    }
  }
  for (const p of picks) {
    add(p.player, p.mlbTeam || "", "draft", p.pick);
  }
  return tasks;
}

function applyPlayerIds(
  preBuckets: TeamBucket[],
  minorBuckets: TeamBucket[],
  idByIdentity: Map<string, string>
): void {
  const setPid = (name: string, target: Drafted) => {
    const ik = rosterIdentityKey(name);
    const id = idByIdentity.get(ik);
    if (!id) {
      throw new Error(`Internal: missing resolution for identity ${ik} (${name})`);
    }
    target.player_id = id;
  };

  for (const b of preBuckets) {
    for (const p of b.players) {
      setPid(p.name, p);
    }
  }
  for (const b of minorBuckets) {
    for (const p of b.players) {
      setPid(p.name, p);
    }
  }
}

function distinctTeamIds(
  preBuckets: TeamBucket[],
  minorBuckets: TeamBucket[],
  picks: { wonTeamId: string }[]
): string[] {
  const s = new Set<string>();
  for (const b of [...preBuckets, ...minorBuckets]) s.add(b.team_id);
  for (const p of picks) s.add(p.wonTeamId);
  return [...s].sort();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const skipMlbSearch = argv.includes("--skip-mlb-search");
  const argPath = argv.find((a) => !a.startsWith("-"));
  const xlsxPath = argPath
    ? path.resolve(argPath)
    : path.join(process.env.HOME ?? "", "Downloads", "2026Draft.xlsx");

  if (!fs.existsSync(xlsxPath)) {
    console.error(`File not found: ${xlsxPath}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(xlsxPath);
  const preRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Pre-Draft Roster"], {
    header: 1,
    defval: "",
    raw: false,
  }) as unknown[][];
  const minorRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Minors"], {
    header: 1,
    defval: "",
    raw: false,
  }) as unknown[][];
  const draftRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Draft"], {
    header: 1,
    defval: "",
    raw: false,
  }) as unknown[][];

  const preBuckets = parsePreDraftRoster(preRows);
  const minorBuckets = parseMinors(minorRows);
  const { picks, warnings: draftWarnings, pickGaps, duplicatePickNumbers } = parseDraft(draftRows);

  const catalog = await loadMongoCatalog();
  console.log(
    `Mongo catalog: ${catalog.length} rows${process.env.MONGO_URI ? "" : " (MONGO_URI unset — Mongo matching disabled)"}`
  );

  const tasks = collectTasks(preBuckets, minorBuckets, picks);
  console.log(`Unique name resolution tasks: ${tasks.size}`);

  const allWarnings: string[] = [...draftWarnings];
  const { idByIdentity, entries } = await resolveAllTasks(
    tasks,
    catalog,
    skipMlbSearch,
    allWarnings
  );

  applyPlayerIds(preBuckets, minorBuckets, idByIdentity);

  const stubCount = entries.filter((e) => e.catalog_match_status === "stub").length;
  console.log(
    `Resolved: ${entries.length - stubCount} / ${entries.length}; stub(synthetic): ${stubCount}`
  );
  if (allWarnings.length) {
    console.warn(`Warnings (${allWarnings.length}), first 25:`);
    for (const w of allWarnings.slice(0, 25)) console.warn(" ", w);
  }

  const teamIds = distinctTeamIds(preBuckets, minorBuckets, picks);
  const numTeams = Math.max(teamIds.length, 1);
  const totalBudget = 260;
  const budgetStart = parsePreDraftBudgets(preRows[0] ?? []);
  for (const tid of teamIds) {
    if (!budgetStart.has(tid)) budgetStart.set(tid, totalBudget);
  }

  fs.mkdirSync(OUT_TEST, { recursive: true });
  fs.mkdirSync(OUT_PUBLIC, { recursive: true });

  const report = {
    schema_version: "1" as const,
    generated_at: new Date().toISOString(),
    xlsx_path: xlsxPath,
    mongo_catalog_rows: catalog.length,
    mongo_uri_set: Boolean(process.env.MONGO_URI?.trim()),
    skip_mlb_search: skipMlbSearch,
    entries,
    warnings: allWarnings,
    pick_gaps: pickGaps,
    duplicate_pick_numbers: duplicatePickNumbers,
    summary: {
      unique_resolution_tasks: entries.length,
      stub_unresolved_count: stubCount,
    },
  };
  const reportJson = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(OUT_TEST, "conversion-match-report.json"), reportJson, "utf8");
  fs.writeFileSync(path.join(OUT_PUBLIC, "conversion-match-report.json"), reportJson, "utf8");
  console.log("wrote conversion-match-report.json");

  for (const nPicks of CHECKPOINTS) {
    const checkpoint =
      nPicks === 0
        ? "pre_draft"
        : nPicks === 10
          ? "after_pick_10"
          : nPicks === 50
            ? "after_pick_50"
            : nPicks === 100
              ? "after_pick_100"
              : "after_pick_130";

    const slice = nPicks === 0 ? [] : picks.filter((p) => p.pick <= nPicks);
    const drafted: Drafted[] = slice.map((p) => {
      const player_id = idByIdentity.get(rosterIdentityKey(p.player));
      if (!player_id) throw new Error(`Missing id for draft pick ${p.pick} ${p.player}`);
      return {
        player_id,
        name: p.player,
        position: p.position,
        team: p.mlbTeam,
        team_id: p.wonTeamId,
        paid: p.salary,
        pick_number: p.pick,
      };
    });

    const spendByTeam = new Map<string, number>();
    for (const tid of teamIds) spendByTeam.set(tid, 0);
    for (const p of slice) {
      spendByTeam.set(p.wonTeamId, (spendByTeam.get(p.wonTeamId) ?? 0) + p.salary);
    }
    const budget_by_team_id: Record<string, number> = {};
    for (const tid of teamIds) {
      const start = budgetStart.get(tid) ?? totalBudget;
      budget_by_team_id[tid] = Math.max(0, start - (spendByTeam.get(tid) ?? 0));
    }

    const body = {
      schema_version: "1.0.0",
      checkpoint,
      roster_slots: DEFAULT_ROSTER_SLOTS,
      scoring_categories: DEFAULT_SCORING,
      total_budget: totalBudget,
      num_teams: numTeams,
      league_scope: "Mixed" as const,
      scoring_format: "5x5" as const,
      inflation_model: "replacement_slots_v2" as const,
      drafted_players: drafted,
      pre_draft_rosters: preBuckets,
      minors: minorBuckets,
      taxi: [] as TeamBucket[],
      budget_by_team_id,
      deterministic: true,
      seed: 42,
    };

    const fname =
      checkpoint === "pre_draft" ? "pre_draft.json" : `after_pick_${nPicks}.json`;
    const json = JSON.stringify(body, null, 2);
    fs.writeFileSync(path.join(OUT_TEST, fname), json, "utf8");
    fs.writeFileSync(path.join(OUT_PUBLIC, fname), json, "utf8");
    console.log("wrote", fname, "drafted", drafted.length);
  }

  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
