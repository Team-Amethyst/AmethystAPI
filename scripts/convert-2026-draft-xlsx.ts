/**
 * Converts instructor 2026Draft.xlsx → five valuation checkpoint JSON files.
 * See docs/draft-2026-xlsx-mapping.md
 *
 * Usage: pnpm run convert-2026-draft -- [path/to/2026Draft.xlsx]
 */
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import type { CellObject } from "xlsx";

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
      const salRaw = row[b.startCol + 3];
      const paid =
        typeof salRaw === "number" && Number.isFinite(salRaw)
          ? salRaw
          : Number(cellStr(salRaw)) || 0;
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
} {
  const picks: {
    pick: number;
    player: string;
    position: string;
    mlbTeam: string;
    wonTeamId: string;
    salary: number;
  }[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const pick = Number(row[0]);
    if (!Number.isFinite(pick)) continue;
    const won = cellStr(row[5]);
    const tid = teamIdFromLabel(won);
    if (!tid) continue;
    const salary = typeof row[6] === "number" ? row[6] : Number(cellStr(row[6])) || 0;
    picks.push({
      pick,
      player: cellStr(row[2]),
      position: cellStr(row[3]) || "UTIL",
      mlbTeam: cellStr(row[4]) || "UNK",
      wonTeamId: tid,
      salary,
    });
  }
  picks.sort((a, b) => a.pick - b.pick);
  return { picks };
}

function collectNames(
  preBuckets: TeamBucket[],
  minorBuckets: TeamBucket[],
  picks: { player: string }[]
): string[] {
  const set = new Set<string>();
  for (const b of [...preBuckets, ...minorBuckets]) {
    for (const p of b.players) {
      if (p.name) set.add(p.name.trim());
    }
  }
  for (const p of picks) {
    if (p.player) set.add(p.player.trim());
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function assignIds(names: string[]): Map<string, string> {
  const m = new Map<string, string>();
  let i = 1;
  for (const n of names) {
    m.set(n.toLowerCase(), String(i));
    i += 1;
  }
  return m;
}

function fillIds(buckets: TeamBucket[], idByName: Map<string, string>): void {
  for (const b of buckets) {
    for (const p of b.players) {
      const id = idByName.get(p.name.trim().toLowerCase());
      if (!id) throw new Error(`Missing id for ${p.name}`);
      p.player_id = id;
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

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const argPath = args[0];
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
  const { picks } = parseDraft(draftRows);

  const names = collectNames(preBuckets, minorBuckets, picks);
  const idByName = assignIds(names);
  fillIds(preBuckets, idByName);
  fillIds(minorBuckets, idByName);

  const teamIds = distinctTeamIds(preBuckets, minorBuckets, picks);
  const numTeams = Math.max(teamIds.length, 1);
  const totalBudget = 260;
  const budgetStart = parsePreDraftBudgets(preRows[0] ?? []);
  for (const tid of teamIds) {
    if (!budgetStart.has(tid)) budgetStart.set(tid, totalBudget);
  }

  fs.mkdirSync(OUT_TEST, { recursive: true });
  fs.mkdirSync(OUT_PUBLIC, { recursive: true });

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
    const drafted: Drafted[] = slice.map((p) => ({
      player_id: idByName.get(p.player.trim().toLowerCase())!,
      name: p.player,
      position: p.position,
      team: p.mlbTeam,
      team_id: p.wonTeamId,
      paid: p.salary,
      pick_number: p.pick,
    }));

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
      drafted_players: drafted,
      pre_draft_rosters: preBuckets,
      minors: minorBuckets,
      taxi: [] as TeamBucket[],
      budget_by_team_id,
      deterministic: true,
      seed: 42,
    };

    const fname =
      checkpoint === "pre_draft"
        ? "pre_draft.json"
        : `after_pick_${nPicks}.json`;
    const json = JSON.stringify(body, null, 2);
    fs.writeFileSync(path.join(OUT_TEST, fname), json, "utf8");
    fs.writeFileSync(path.join(OUT_PUBLIC, fname), json, "utf8");
    console.log("wrote", fname, "drafted", drafted.length);
  }

  console.log("max synthetic player_id:", String(names.length));
}

main();
