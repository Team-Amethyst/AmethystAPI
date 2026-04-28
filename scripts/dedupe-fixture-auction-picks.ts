/**
 * Remove auction `drafted_players` rows whose `player_id` already appears on
 * `pre_draft_rosters`, `minors`, or `taxi` (keepers / reserved — not in auction pool).
 * Recomputes `budget_by_team_id` from sibling `pre_draft.json` post-keeper balances
 * minus cumulative `paid` on remaining auction picks per team.
 *
 * Usage: pnpm exec ts-node --project tsconfig.scripts.json scripts/dedupe-fixture-auction-picks.ts
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

function collectRosteredPlayerIds(body: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const addRows = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (typeof row !== "object" || row == null) continue;
      const pid = (row as { player_id?: string }).player_id;
      if (typeof pid === "string" && pid.length > 0) ids.add(pid);
    }
  };
  const pre = body.pre_draft_rosters;
  if (Array.isArray(pre)) {
    for (const bucket of pre) {
      addRows((bucket as { players?: unknown }).players);
    }
  } else if (pre && typeof pre === "object") {
    for (const rows of Object.values(pre as Record<string, unknown>)) {
      addRows(rows);
    }
  }
  for (const key of ["minors", "taxi"] as const) {
    const b = body[key];
    if (!Array.isArray(b)) continue;
    for (const bucket of b) {
      addRows((bucket as { players?: unknown }).players);
    }
  }
  return ids;
}

function loadPostKeeperBudgets(dir: string): Record<string, number> {
  const prePath = path.join(dir, "pre_draft.json");
  const raw = JSON.parse(readFileSync(prePath, "utf8")) as Record<string, unknown>;
  const m = raw.budget_by_team_id;
  if (!m || typeof m !== "object") {
    throw new Error(`Missing budget_by_team_id in ${prePath}`);
  }
  return { ...(m as Record<string, number>) };
}

function recomputeBudgets(
  start: Record<string, number>,
  drafted: { team_id?: string; paid?: number }[]
): Record<string, number> {
  const out = { ...start };
  for (const d of drafted) {
    const tid = d.team_id;
    if (typeof tid !== "string" || !tid) continue;
    const paid = d.paid;
    if (typeof paid === "number" && Number.isFinite(paid)) {
      out[tid] = (out[tid] ?? 0) - paid;
    }
  }
  for (const k of Object.keys(out)) {
    if (!Number.isFinite(out[k])) out[k] = 0;
    out[k] = Math.max(0, out[k]);
  }
  return out;
}

function processFile(filePath: string, dir: string): { removed: number; kept: number } {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const drafted = raw.drafted_players;
  if (!Array.isArray(drafted)) return { removed: 0, kept: 0 };

  const rostered = collectRosteredPlayerIds(raw);
  const before = drafted.length;
  const filtered = drafted.filter((row: Record<string, unknown>) => {
    const pid = row.player_id;
    if (typeof pid !== "string") return true;
    return !rostered.has(pid);
  });
  const removed = before - filtered.length;
  if (removed === 0) return { removed: 0, kept: filtered.length };

  raw.drafted_players = filtered;
  try {
    const start = loadPostKeeperBudgets(dir);
    raw.budget_by_team_id = recomputeBudgets(start, filtered as { team_id?: string; paid?: number }[]);
  } catch {
    console.warn("  skip budget recompute (no pre_draft.json in dir):", dir);
  }

  writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return { removed, kept: filtered.length };
}

function main(): void {
  const dirs = [
    path.join(ROOT, "test-fixtures/player-api/checkpoints"),
    path.join(ROOT, "public/fixtures/checkpoints"),
  ];
  let totalRemoved = 0;
  for (const dir of dirs) {
    const names = readdirSync(dir).filter(
      (n) =>
        n.startsWith("after_pick_") &&
        n.endsWith(".json") &&
        n !== "conversion-match-report.json"
    );
    for (const n of names.sort()) {
      const fp = path.join(dir, n);
      const { removed, kept } = processFile(fp, dir);
      if (removed > 0) {
        console.log(`${fp}: removed ${removed} duplicate(s), drafted now ${kept}`);
        totalRemoved += removed;
      }
    }
  }
  console.log(`done. total auction rows removed: ${totalRemoved}`);
}

main();
