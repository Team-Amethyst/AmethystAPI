/**
 * True per-pick historic replay: rebuild the board before each auction pick from a
 * terminal checkpoint (full `drafted_players` + league template) and `pre_draft.json`
 * post-keeper `budget_by_team_id`, then run valuation as the drafting team.
 *
 * Defaults (override with --full / --pre):
 *   test-fixtures/player-api/checkpoints/after_pick_130.json
 *   test-fixtures/player-api/checkpoints/pre_draft.json
 *
 * Optional: --max-picks N  --ndjson  (one JSON object per pick to stdout)
 *
 * Requires MONGO_URI.
 * Run: pnpm replay-per-pick-draft
 */
import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import Player from "../src/models/Player";
import { PLAYER_CATALOG_LEAN_SELECT } from "../src/lib/playerCatalogProjection";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { DraftedPlayer, LeanPlayer } from "../src/types/brain";

const ROOT = path.resolve(__dirname, "..");

const DEFAULT_FULL = path.join(
  ROOT,
  "test-fixtures/player-api/checkpoints/after_pick_130.json"
);
const DEFAULT_PRE = path.join(
  ROOT,
  "test-fixtures/player-api/checkpoints/pre_draft.json"
);

function parseArgs(): { full: string; pre: string; maxPicks?: number; ndjson: boolean } {
  const args = process.argv.slice(2);
  let full = DEFAULT_FULL;
  let pre = DEFAULT_PRE;
  let maxPicks: number | undefined;
  let ndjson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--full" && args[i + 1]) full = path.resolve(process.cwd(), args[++i]);
    else if (a === "--pre" && args[i + 1]) pre = path.resolve(process.cwd(), args[++i]);
    else if (a === "--max-picks" && args[i + 1]) maxPicks = parseInt(args[++i], 10);
    else if (a === "--ndjson") ndjson = true;
  }
  return { full, pre, maxPicks, ndjson };
}

function sortDraftOrder(drafted: DraftedPlayer[]): DraftedPlayer[] {
  return [...drafted].sort((a, b) => {
    const pa = typeof a.pick_number === "number" ? a.pick_number : 999999;
    const pb = typeof b.pick_number === "number" ? b.pick_number : 999999;
    if (pa !== pb) return pa - pb;
    return String(a.player_id).localeCompare(String(b.player_id));
  });
}

function budgetAfterKeepers(
  preRaw: Record<string, unknown>
): Record<string, number> {
  const m = preRaw.budget_by_team_id;
  if (!m || typeof m !== "object") {
    throw new Error("pre_draft JSON must include budget_by_team_id (post-keeper cash)");
  }
  return { ...(m as Record<string, number>) };
}

function subtractAuctionSpend(
  budgets: Record<string, number>,
  picks: DraftedPlayer[]
): void {
  for (const p of picks) {
    const tid = p.team_id;
    if (!tid || typeof tid !== "string") continue;
    const paid = p.paid;
    if (typeof paid !== "number" || !Number.isFinite(paid)) continue;
    budgets[tid] = (budgets[tid] ?? 0) - paid;
  }
}

async function loadMongoPool(): Promise<LeanPlayer[]> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing");
  await mongoose.connect(uri);
  try {
    const docs = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean().exec();
    return normalizeCatalogPlayers(docs, () => undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

type PickEval = {
  pick_index: number;
  pick_number: number | null;
  team_id: string;
  player_id: string;
  name: string;
  position: string;
  paid: number;
  baseline: number;
  adjusted: number;
  recommended: number | null;
  team_adjusted: number | null;
  abs_err_rec: number;
  abs_err_team: number;
  abs_err_adj: number;
  team_closer_than_adj: boolean;
  market_closer_than_adj: boolean;
};

async function main(): Promise<void> {
  const { full, pre, maxPicks, ndjson } = parseArgs();
  const template = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
  const preRaw = JSON.parse(readFileSync(pre, "utf8")) as Record<string, unknown>;
  const drafted = template.drafted_players as DraftedPlayer[] | undefined;
  if (!Array.isArray(drafted) || drafted.length === 0) {
    throw new Error(`No drafted_players in ${full}`);
  }
  const sorted = sortDraftOrder(drafted);
  const keeperBudgets = budgetAfterKeepers(preRaw);
  const pool = await loadMongoPool();

  const rows: PickEval[] = [];
  const limit = Math.min(sorted.length, maxPicks ?? sorted.length);

  for (let i = 0; i < limit; i++) {
    const prior = sorted.slice(0, i);
    const pick = sorted[i]!;
    const paid = pick.paid ?? NaN;
    if (!Number.isFinite(paid)) continue;

    const budgets = { ...keeperBudgets };
    subtractAuctionSpend(budgets, prior);

    const teamId =
      typeof pick.team_id === "string" && pick.team_id.length > 0
        ? pick.team_id
        : "team_1";

    const raw: Record<string, unknown> = {
      ...template,
      drafted_players: prior,
      budget_by_team_id: budgets,
      checkpoint: `synthetic_after_pick_${i}`,
      user_team_id: teamId,
      inflation_model: template.inflation_model ?? "replacement_slots_v2",
    };

    const parsed = parseValuationRequest(raw as Record<string, unknown>);
    if (!parsed.success) continue;
    const out = executeValuationWorkflow(pool, parsed.normalized, {});
    if (!out.ok) continue;

    const vrow = out.response.valuations.find((r) => r.player_id === pick.player_id);
    if (!vrow) continue;

    const rec =
      typeof vrow.recommended_bid === "number" ? vrow.recommended_bid : null;
    const tav =
      typeof vrow.team_adjusted_value === "number" ? vrow.team_adjusted_value : null;
    const absErrRec = Math.abs(paid - (rec ?? vrow.adjusted_value));
    const absErrTeam = Math.abs(paid - (tav ?? vrow.adjusted_value));
    const absErrAdj = Math.abs(paid - vrow.adjusted_value);

    const row: PickEval = {
      pick_index: i + 1,
      pick_number: typeof pick.pick_number === "number" ? pick.pick_number : null,
      team_id: teamId,
      player_id: pick.player_id,
      name: pick.name,
      position: pick.position,
      paid,
      baseline: vrow.baseline_value,
      adjusted: vrow.adjusted_value,
      recommended: rec,
      team_adjusted: tav,
      abs_err_rec: absErrRec,
      abs_err_team: absErrTeam,
      abs_err_adj: absErrAdj,
      team_closer_than_adj: absErrTeam < absErrAdj - 1e-6,
      market_closer_than_adj: absErrRec < absErrAdj - 1e-6,
    };
    rows.push(row);
    if (ndjson) console.log(JSON.stringify(row));
  }

  if (ndjson) return;

  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
  const summary = {
    source_full: full,
    source_pre: pre,
    picks_scored: rows.length,
    overall_mae: {
      recommended: mean(rows.map((r) => r.abs_err_rec)),
      team_adjusted: mean(rows.map((r) => r.abs_err_team)),
      adjusted: mean(rows.map((r) => r.abs_err_adj)),
    },
    usefulness_pct: {
      team_adjusted_closer_to_paid_than_adjusted:
        rows.length > 0
          ? (rows.filter((r) => r.team_closer_than_adj).length / rows.length) * 100
          : NaN,
      recommended_closer_to_paid_than_adjusted:
        rows.length > 0
          ? (rows.filter((r) => r.market_closer_than_adj).length / rows.length) * 100
          : NaN,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
