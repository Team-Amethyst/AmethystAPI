/**
 * Audit team_adjusted_value vs auction_value across draft/economic scenarios.
 * Run: MONGO_URI=... pnpm exec tsx scripts/team-adjusted-value-audit.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import type { DraftedPlayer, LeanPlayer } from "../src/types/brain";
import { getPlayerId } from "../src/lib/playerId";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";
import { playerTokensFromLean } from "../src/lib/fantasyRosterSlots";

const NUM_TEAMS = 12;
const TOTAL_BUDGET = 260;
const USER = "team_1";

function tokensOf(p: LeanPlayer) {
  return playerTokensFromLean(p);
}

function isCatcher(p: LeanPlayer): boolean {
  return tokensOf(p).includes("C");
}

function isShortstop(p: LeanPlayer): boolean {
  return tokensOf(p).includes("SS");
}

function mkDraft(
  p: LeanPlayer,
  team_id: string,
  paid = 3
): DraftedPlayer {
  return {
    player_id: getPlayerId(p),
    name: p.name,
    position: p.position,
    team: p.team,
    team_id,
    paid,
  };
}

/** Deterministic round-robin snake could vary — use strict round-robin by draft order index */
function roundRobin(
  pool: LeanPlayer[],
  nPicks: number,
  bid = 3
): DraftedPlayer[] {
  const sorted = [...pool].sort((a, b) => (b.value || 0) - (a.value || 0));
  const out: DraftedPlayer[] = [];
  const used = new Set<string>();
  for (const p of sorted) {
    if (out.length >= nPicks) break;
    const id = getPlayerId(p);
    if (used.has(id)) continue;
    used.add(id);
    const teamNum = (out.length % NUM_TEAMS) + 1;
    out.push(mkDraft(p, `team_${teamNum}`, bid));
  }
  return out;
}

/** Team 1 only: top-N players matching predicate */
function team1Draft(
  pool: LeanPlayer[],
  n: number,
  pred: (p: LeanPlayer) => boolean,
  bid = 3
): DraftedPlayer[] {
  const sorted = [...pool].sort((a, b) => (b.value || 0) - (a.value || 0));
  const out: DraftedPlayer[] = [];
  for (const p of sorted) {
    if (out.length >= n) break;
    if (!pred(p)) continue;
    out.push(mkDraft(p, USER, bid));
  }
  return out;
}

function keeperHeavy(pool: LeanPlayer[]): DraftedPlayer[] {
  const sorted = [...pool].sort((a, b) => (b.value || 0) - (a.value || 0));
  const out: DraftedPlayer[] = [];
  // 4 teams × 3 keepers = 12 players, rotate teams
  let idx = 0;
  for (let t = 0; t < 4; t++) {
    const tid = `team_${t + 1}`;
    for (let k = 0; k < 3; k++) {
      while (idx < sorted.length) {
        const p = sorted[idx++]!;
        const id = getPlayerId(p);
        if (out.some((d) => d.player_id === id)) continue;
        out.push({
          ...mkDraft(p, tid, 22),
          is_keeper: true,
          keeper_cost: 22,
        });
        break;
      }
    }
  }
  return out;
}

type Row = {
  player_id: string;
  name: string;
  auction_value: number;
  team_adjusted_value: number;
  edge: number;
  recommended_bid?: number;
  replacement_key_used?: string | null;
  need?: number;
  budget?: number;
  dps?: number;
  slot_scarcity?: number;
  repl_drop?: number;
};

function summarizeScenario(
  label: string,
  rows: Row[],
  poolById: Map<string, LeanPlayer>
) {
  const edges = rows.map((r) => r.edge);
  const meanAbs =
    edges.reduce((s, e) => s + Math.abs(e), 0) / Math.max(1, edges.length);
  const maxEdge = rows.reduce(
    (best, r) => (r.edge > best.edge ? r : best),
    rows[0]!
  );
  const minEdge = rows.reduce(
    (best, r) => (r.edge < best.edge ? r : best),
    rows[0]!
  );

  const byCat = (pred: (p: LeanPlayer) => boolean) => {
    const sub = rows.filter((r) => pred(poolById.get(r.player_id)!));
    if (sub.length === 0)
      return { n: 0, median_edge: null as number | null };
    const es = sub.map((r) => r.edge).sort((a, b) => a - b);
    const mid = es[Math.floor(es.length / 2)]!;
    return { n: sub.length, median_edge: mid };
  };

  const topBy = (key: keyof Row, n = 8) =>
    [...rows]
      .sort((a, b) => (b[key] as number) - (a[key] as number))
      .slice(0, n)
      .map((r) => ({
        name: r.name,
        player_id: r.player_id,
        auction_value: r.auction_value,
        team_adjusted_value: r.team_adjusted_value,
        edge: r.edge,
      }));

  return {
    label,
    count: rows.length,
    mean_abs_edge: Number(meanAbs.toFixed(4)),
    max_edge_player: {
      name: maxEdge.name,
      edge: Number(maxEdge.edge.toFixed(2)),
      auction_value: maxEdge.auction_value,
      ta: maxEdge.team_adjusted_value,
    },
    min_edge_player: {
      name: minEdge.name,
      edge: Number(minEdge.edge.toFixed(2)),
    },
    median_edge_catchers: byCat(isCatcher),
    median_edge_pitchers: byCat((p) => isPitcherForBaseline(p)),
    median_edge_ss: byCat(isShortstop),
    top_by_auction: topBy("auction_value"),
    top_by_team_adjusted: topBy("team_adjusted_value"),
    top_by_edge: topBy("edge"),
    sample_multiplier_row:
      rows.find((r) => r.need != null && r.need !== 1) ?? rows[0],
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI ?? process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI or MONGODB_URI required");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let pool: LeanPlayer[];
  try {
    pool = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const poolById = new Map(pool.map((p) => [getPlayerId(p), p]));

  const baseOpts = {
    inflation_model: "replacement_slots_v2" as const,
    deterministic: true,
    seed: 42,
    explain_valuation_rows: true,
    user_team_id: USER,
  };

  const scenarios: { id: string; extra: Record<string, unknown> }[] = [
    { id: "fresh_no_picks", extra: { drafted_players: [] } },
    { id: "after_25_rr", extra: { drafted_players: roundRobin(pool, 25) } },
    { id: "after_75_rr", extra: { drafted_players: roundRobin(pool, 75) } },
    { id: "after_150_rr", extra: { drafted_players: roundRobin(pool, 150) } },
    {
      id: "team1_needs_catcher",
      extra: {
        drafted_players: team1Draft(
          pool,
          20,
          (p) => !isCatcher(p) && !isPitcherForBaseline(p)
        ),
      },
    },
    {
      id: "team1_needs_pitching",
      extra: {
        drafted_players: team1Draft(
          pool,
          18,
          (p) => isPitcherForBaseline(p) === false
        ),
      },
    },
    {
      id: "team1_ss_full",
      extra: {
        drafted_players: [
          ...team1Draft(
            pool,
            2,
            (p) => isShortstop(p),
            15
          ),
          ...team1Draft(
            pool,
            14,
            (p) => !isShortstop(p),
            3
          ),
        ],
      },
    },
    {
      id: "team1_low_budget",
      extra: {
        drafted_players: roundRobin(pool, 60),
        budget_by_team_id: Object.fromEntries(
          Array.from({ length: NUM_TEAMS }, (_, i) => {
            const tid = `team_${i + 1}`;
            return [tid, tid === USER ? 35 : TOTAL_BUDGET] as const;
          })
        ),
      },
    },
    {
      id: "team1_high_budget",
      extra: {
        drafted_players: roundRobin(pool, 60),
        budget_by_team_id: Object.fromEntries(
          Array.from({ length: NUM_TEAMS }, (_, i) => {
            const tid = `team_${i + 1}`;
            return [tid, tid === USER ? 220 : TOTAL_BUDGET] as const;
          })
        ),
      },
    },
    {
      id: "keeper_heavy_spread",
      extra: { drafted_players: keeperHeavy(pool) },
    },
  ];

  const table: ReturnType<typeof summarizeScenario>[] = [];
  const suspicious: string[] = [];

  for (const sc of scenarios) {
    const input = buildDraftroomStandardValuationInput({
      ...baseOpts,
      ...(sc.extra as object),
    });
    const ov = positionOverridesFromRequest(input.position_overrides);
    const wf = executeValuationWorkflow(pool, input, {}, { debugSignals: true });
    if (!wf.ok) {
      suspicious.push(`${sc.id}: workflow failed: ${wf.issues.join("; ")}`);
      continue;
    }
    const rows: Row[] = wf.response.valuations.map((v) => {
      const dbg = v.debug_v2?.team_multipliers;
      const tm =
        dbg && !("symmetric_open_collapsed" in dbg)
          ? (dbg as {
              need: number;
              budget: number;
              dollars_per_slot: number;
              slot_scarcity: number;
              replacement_dropoff: number;
            })
          : undefined;
      return {
        player_id: v.player_id,
        name: v.name,
        auction_value: v.auction_value,
        team_adjusted_value: v.team_adjusted_value ?? v.auction_value,
        edge:
          (v.team_adjusted_value ?? v.auction_value) - v.auction_value,
        recommended_bid: v.recommended_bid,
        replacement_key_used:
          v.valuation_explain?.replacement_key_used ??
          v.debug_v2?.replacement_key_used ??
          null,
        need: tm?.need,
        budget: tm?.budget,
        dps: tm?.dollars_per_slot,
        slot_scarcity: tm?.slot_scarcity,
        repl_drop: tm?.replacement_dropoff,
      };
    });

    const sum = summarizeScenario(sc.id, rows, poolById);
    table.push(sum);

    if (sc.id !== "fresh_no_picks" && sum.mean_abs_edge < 0.02) {
      suspicious.push(
        `${sc.id}: mean_abs_edge ${sum.mean_abs_edge} — team_adjusted barely diverges from auction_value`
      );
    }
  }

  const fresh = table.find((t) => t.label === "fresh_no_picks");
  if (fresh && fresh.mean_abs_edge > 0.05) {
    suspicious.push(
      `fresh_no_picks: expected ~collapse to auction_value; mean_abs_edge=${fresh.mean_abs_edge}`
    );
  }

  const needsC = table.find((t) => t.label === "team1_needs_catcher");
  const baseline = table.find((t) => t.label === "after_75_rr");
  if (
    needsC &&
    baseline &&
    needsC.median_edge_catchers.median_edge != null &&
    baseline.median_edge_catchers.median_edge != null &&
    needsC.median_edge_catchers.median_edge <=
      baseline.median_edge_catchers.median_edge
  ) {
    suspicious.push(
      "team1_needs_catcher: catcher median edge did not exceed mid-draft baseline (need signal unexpected)"
    );
  }

  const needsP = table.find((t) => t.label === "team1_needs_pitching");
  if (
    needsP &&
    baseline &&
    needsP.median_edge_pitchers.median_edge != null &&
    baseline.median_edge_pitchers.median_edge != null &&
    needsP.median_edge_pitchers.median_edge <=
      baseline.median_edge_pitchers.median_edge
  ) {
    suspicious.push(
      "team1_needs_pitching: pitcher median edge did not exceed mid-draft baseline"
    );
  }

  const lowB = table.find((t) => t.label === "team1_low_budget");
  const highB = table.find((t) => t.label === "team1_high_budget");
  if (
    lowB &&
    highB &&
    lowB.top_by_team_adjusted[0] &&
    highB.top_by_team_adjusted[0]
  ) {
    const lowTop = lowB.top_by_team_adjusted[0]!.team_adjusted_value;
    const highTop = highB.top_by_team_adjusted[0]!.team_adjusted_value;
    if (lowTop >= highTop * 0.99) {
      suspicious.push(
        "budget extremes: top team_adjusted star similar for low vs high budget (budget multiplier may be weak)"
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        scenarios: table,
        suspicious,
        notes: {
          team_adjusted_formula:
            "need × budget × dps × slot_scarcity × replacement_dropoff × adjusted_value (capped); symmetric open league collapses to adjusted_value",
          user_team: USER,
        },
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
