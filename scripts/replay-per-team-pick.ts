/**
 * Replay historic checkpoints: for each newly drafted player, re-run valuation as the
 * drafting team (user_team_id = pick.team_id) on the prior board state, then score how
 * useful market vs personal lines would have been vs realized paid.
 *
 * Note: manifest steps jump by many picks (e.g. 10→50); all new picks in a batch share
 * the same prior board — same limitation as replay-four-values-eval.
 *
 * Requires MONGO_URI. Run: pnpm replay-per-team-pick
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
import type { DraftedPlayer, LeanPlayer, NormalizedValuationInput } from "../src/types/brain";

type Manifest = { steps: { label: string; request_path: string }[] };

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "test-fixtures/replay-evaluator/manifest.json");

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
  if (n.pre_draft_rosters) {
    for (const rows of Object.values(n.pre_draft_rosters)) {
      collectUnknownRows(Array.isArray(rows) ? rows : []);
    }
  }
  const collectBuckets = (buckets: NormalizedValuationInput["minors"]) => {
    if (!buckets) return;
    if (Array.isArray(buckets)) {
      for (const bucket of buckets) collectUnknownRows(bucket.players as unknown[]);
      return;
    }
    for (const v of Object.values(buckets)) {
      if (Array.isArray(v)) collectUnknownRows(v);
    }
  };
  collectBuckets(n.minors);
  collectBuckets(n.taxi);
  return ids;
}

function newAuctionPicks(
  prev: NormalizedValuationInput | null,
  curr: NormalizedValuationInput
): DraftedPlayer[] {
  if (!prev) return [];
  const prevKnown = collectAllRosterPlayerIds(prev);
  return curr.drafted_players.filter((d) => !prevKnown.has(d.player_id));
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

type PickRow = {
  checkpoint_label: string;
  team_id: string;
  player_id: string;
  name: string;
  position: string;
  paid: number;
  baseline: number;
  adjusted: number;
  recommended: number | null;
  team_adjusted: number | null;
  edge: number | null;
  abs_err_rec: number;
  abs_err_team: number;
  abs_err_adj: number;
  team_closer_than_adj: boolean;
  market_better_than_adj: boolean;
};

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

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  const pool = await loadMongoPool();

  let prevNorm: NormalizedValuationInput | null = null;
  const rows: PickRow[] = [];

  for (const step of manifest.steps) {
    const reqPath = path.join(ROOT, step.request_path);
    const raw = JSON.parse(readFileSync(reqPath, "utf8")) as Record<string, unknown>;
    const parsed = parseValuationRequest({
      ...raw,
      inflation_model: raw.inflation_model ?? "replacement_slots_v2",
    });
    if (!parsed.success) continue;
    const n = parsed.normalized;
    const picks = newAuctionPicks(prevNorm, n);

    if (prevNorm) {
      for (const pick of picks) {
        const paid = pick.paid ?? NaN;
        if (!Number.isFinite(paid)) continue;
        const teamId =
          typeof pick.team_id === "string" && pick.team_id.length > 0
            ? pick.team_id
            : prevNorm.user_team_id ?? "team_1";
        const inputForPicker: NormalizedValuationInput = {
          ...prevNorm,
          user_team_id: teamId,
        };
        const out = executeValuationWorkflow(pool, inputForPicker, {});
        if (!out.ok) continue;
        const vrow = out.response.valuations.find((r) => r.player_id === pick.player_id);
        if (!vrow) continue;
        const rec =
          typeof vrow.recommended_bid === "number" ? vrow.recommended_bid : null;
        const tav =
          typeof vrow.team_adjusted_value === "number" ? vrow.team_adjusted_value : null;
        const edge =
          typeof vrow.edge === "number"
            ? vrow.edge
            : tav != null && rec != null
              ? tav - rec
              : null;
        const absErrRec = Math.abs(paid - (rec ?? vrow.adjusted_value));
        const absErrTeam = Math.abs(paid - (tav ?? vrow.adjusted_value));
        const absErrAdj = Math.abs(paid - vrow.adjusted_value);
        rows.push({
          checkpoint_label: step.label,
          team_id: teamId,
          player_id: pick.player_id,
          name: pick.name,
          position: pick.position,
          paid,
          baseline: vrow.baseline_value,
          adjusted: vrow.adjusted_value,
          recommended: rec,
          team_adjusted: tav,
          edge,
          abs_err_rec: absErrRec,
          abs_err_team: absErrTeam,
          abs_err_adj: absErrAdj,
          team_closer_than_adj: absErrTeam < absErrAdj - 1e-6,
          market_better_than_adj: absErrRec < absErrAdj - 1e-6,
        });
      }
    }

    executeValuationWorkflow(pool, n, {});
    prevNorm = n;
  }

  const byTeam = new Map<
    string,
    { n: number; mae_rec: number; mae_team: number; mae_adj: number; closer: number }
  >();
  for (const r of rows) {
    const agg = byTeam.get(r.team_id) ?? {
      n: 0,
      mae_rec: 0,
      mae_team: 0,
      mae_adj: 0,
      closer: 0,
    };
    agg.n += 1;
    agg.mae_rec += r.abs_err_rec;
    agg.mae_team += r.abs_err_team;
    agg.mae_adj += r.abs_err_adj;
    if (r.team_closer_than_adj) agg.closer += 1;
    byTeam.set(r.team_id, agg);
  }

  const teamSummaries = [...byTeam.entries()].map(([team_id, a]) => ({
    team_id,
    picks: a.n,
    mae_recommended: mean(
      rows.filter((x) => x.team_id === team_id).map((x) => x.abs_err_rec)
    ),
    mae_team_adjusted: mean(
      rows.filter((x) => x.team_id === team_id).map((x) => x.abs_err_team)
    ),
    mae_adjusted: mean(
      rows.filter((x) => x.team_id === team_id).map((x) => x.abs_err_adj)
    ),
    pct_team_closer_than_adjusted:
      a.n > 0 ? (a.closer / a.n) * 100 : NaN,
  }));

  const pctTeamCloserOverall =
    rows.length > 0
      ? (rows.filter((r) => r.team_closer_than_adj).length / rows.length) * 100
      : NaN;
  const pctMarketBetterOverall =
    rows.length > 0
      ? (rows.filter((r) => r.market_better_than_adj).length / rows.length) * 100
      : NaN;

  const summary = {
    manifest: MANIFEST_PATH,
    picks_scored: rows.length,
    overall_mae: {
      recommended: mean(rows.map((r) => r.abs_err_rec)),
      team_adjusted: mean(rows.map((r) => r.abs_err_team)),
      adjusted: mean(rows.map((r) => r.abs_err_adj)),
    },
    usefulness_pct: {
      team_adjusted_closer_to_paid_than_adjusted: pctTeamCloserOverall,
      recommended_closer_to_paid_than_adjusted: pctMarketBetterOverall,
    },
    by_team: teamSummaries.sort((a, b) => a.team_id.localeCompare(b.team_id)),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
