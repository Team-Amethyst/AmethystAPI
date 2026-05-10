/**
 * Audit Research "Edge vs Max" (edge = team_adjusted_value − recommended_bid)
 * at simulated draft depths using the real Mongo catalog + executeValuationWorkflow.
 *
 * Run: pnpm audit:research-edge
 * Requires MONGO_URI. Writes tmp/research-edge-audit.json.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import type { DraftedPlayer, LeanPlayer, ValuedPlayer } from "../src/types/brain";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { getPlayerId } from "../src/lib/playerId";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import {
  buildDraftroomStandardValuationInput,
} from "../src/lib/calibrationDraftroomFixture";
import { leagueSlotCapacity } from "../src/services/teamAdjustedValue";

const ROOT = path.resolve(__dirname, "..");
const EPS = 0.5;

function snakeTeamIndex(pickIndex: number, numTeams: number): number {
  const round = Math.floor(pickIndex / numTeams);
  const pos = pickIndex % numTeams;
  return round % 2 === 0 ? pos : numTeams - 1 - pos;
}

/**
 * Simulate picks in **catalog_rank** order (internal model sort — same role old `adp` on Mongo
 * used before rename). Not `market_adp`.
 */
function buildDraftedFromCatalogRankOrder(
  pool: LeanPlayer[],
  nPicks: number,
  numTeams: number
): DraftedPlayer[] {
  const sorted = [...pool]
    .filter((p) => Number.isFinite(p.catalog_rank) && p.catalog_rank > 0)
    .sort((a, b) => a.catalog_rank - b.catalog_rank);
  const out: DraftedPlayer[] = [];
  for (let i = 0; i < nPicks && i < sorted.length; i++) {
    const p = sorted[i]!;
    const teamIdx = snakeTeamIndex(i, numTeams);
    out.push({
      player_id: getPlayerId(p),
      name: p.name,
      position: p.position,
      team: p.team ?? "",
      team_id: `team_${teamIdx + 1}`,
      paid: 2 + (i % 7),
    });
  }
  return out;
}

function bucketEdge(e: number): "positive" | "negative" | "neutral" {
  if (e > EPS) return "positive";
  if (e < -EPS) return "negative";
  return "neutral";
}

/** Buckets edge by **catalog_tier** (preseason dollar bands), not auction_tier quintiles. */
function summarizeRows(rows: ValuedPlayer[]) {
  let pos = 0;
  let neg = 0;
  let neu = 0;
  const byTier = new Map<number, { pos: number; neg: number; neu: number }>();
  for (const r of rows) {
    const e = r.edge ?? 0;
    const b = bucketEdge(e);
    if (b === "positive") pos++;
    else if (b === "negative") neg++;
    else neu++;
    const t = r.catalog_tier;
    if (!byTier.has(t)) byTier.set(t, { pos: 0, neg: 0, neu: 0 });
    const bt = byTier.get(t)!;
    if (b === "positive") bt.pos++;
    else if (b === "negative") bt.neg++;
    else bt.neu++;
  }
  const n = rows.length || 1;
  return {
    row_count: rows.length,
    positive: pos,
    negative: neg,
    neutral: neu,
    pct_positive: Number(((100 * pos) / n).toFixed(2)),
    pct_negative: Number(((100 * neg) / n).toFixed(2)),
    pct_neutral: Number(((100 * neu) / n).toFixed(2)),
    by_tier: Object.fromEntries(
      [...byTier.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => {
        const m = v.pos + v.neg + v.neu || 1;
        return [
          String(k),
          {
            ...v,
            pct_positive: Number(((100 * v.pos) / m).toFixed(1)),
            pct_negative: Number(((100 * v.neg) / m).toFixed(1)),
            pct_neutral: Number(((100 * v.neu) / m).toFixed(1)),
          },
        ];
      })
    ),
  };
}

function taEqualsAvStats(rows: ValuedPlayer[]) {
  let n = 0;
  let exact = 0;
  let close = 0;
  let maxAbs = 0;
  for (const r of rows) {
    const ta = r.team_adjusted_value ?? r.adjusted_value;
    const av = r.auction_value;
    const d = Math.abs(ta - av);
    n++;
    if (d < 1e-6) exact++;
    if (d <= 0.02) close++;
    maxAbs = Math.max(maxAbs, d);
  }
  return {
    rows: n,
    team_adjusted_eq_auction_count: exact,
    team_adjusted_within_2cents_of_auction: close,
    max_abs_team_adjusted_minus_auction: Number(maxAbs.toFixed(4)),
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required for catalog-backed audit");
  await mongoose.connect(uri);
  let pool: LeanPlayer[];
  try {
    pool = await loadMongoCatalogForEngine(undefined, {
      skipMlbHydration: process.env.AMETHYST_SKIP_MLB_TEAM_HYDRATE === "1",
    });
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const base = buildDraftroomStandardValuationInput({
    user_team_id: "team_1",
  });
  const cap = leagueSlotCapacity(base.roster_slots, base.num_teams);
  const depths = [0, 25, 75, 150] as const;
  const checkpoints: Record<string, unknown>[] = [];

  for (const d of depths) {
    const drafted = buildDraftedFromCatalogRankOrder(pool, d, base.num_teams);
    const res = executeValuationWorkflow(pool, { ...base, drafted_players: drafted }, {});
    if (!res.ok) {
      checkpoints.push({
        picks: d,
        roster_fill_league: cap > 0 ? d / cap : null,
        ok: false,
        issues: res.issues,
      });
      continue;
    }
    const rows = res.response.valuations;
    checkpoints.push({
      picks: d,
      roster_fill_league: cap > 0 ? Number(((d / cap) * 100).toFixed(2)) : null,
      ok: true,
      context_note:
        d === 0
          ? "Symmetric open league (no picks): team_adjusted_value equals auction_value for every row — see ta_vs_av."
          : "Rosters diverge across teams; team_adjusted_value can depart from auction_value for the requesting user_team_id.",
      ta_vs_av: taEqualsAvStats(rows),
      edge_summary: summarizeRows(rows),
      sample_extremes: {
        most_negative_edge: [...rows]
          .sort((a, b) => (a.edge ?? 0) - (b.edge ?? 0))
          .slice(0, 3)
          .map((r) => ({
            player_id: r.player_id,
            name: r.name,
            catalog_tier: r.catalog_tier,
            auction_tier: r.auction_tier,
            auction_value: r.auction_value,
            team_adjusted_value: r.team_adjusted_value,
            recommended_bid: r.recommended_bid,
            edge: r.edge,
          })),
        most_positive_edge: [...rows]
          .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0))
          .slice(0, 3)
          .map((r) => ({
            player_id: r.player_id,
            name: r.name,
            catalog_tier: r.catalog_tier,
            auction_tier: r.auction_tier,
            auction_value: r.auction_value,
            team_adjusted_value: r.team_adjusted_value,
            recommended_bid: r.recommended_bid,
            edge: r.edge,
          })),
      },
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    epsilon_edge_neutral: EPS,
    league_slot_capacity: cap,
    user_team_id: base.user_team_id,
    checkpoints,
    interpretation: {
      edge_definition: "team_adjusted_value - recommended_bid",
      neutral_band: `|edge| <= ${EPS}`,
      draft_simulation_order:
        "Drafted players are removed in ascending catalog_rank order (internal list rank, not market_adp).",
      tier_breakdown:
        "edge_summary.by_tier keys are catalog_tier (Mongo preseason bands). Samples also list auction_tier (within-response auction quintile) for contrast.",
      early_negative_edge_expected:
        "When team_adjusted_value tracks auction_value and recommended_bid is an aggressive ceiling above auction_value for stars, edge is often negative — not a bug.",
    },
  };

  const abs = path.join(ROOT, "tmp", "research-edge-audit.json");
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.error("Wrote", abs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
