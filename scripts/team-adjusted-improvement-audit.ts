/**
 * Focused team_adjusted_value improvement audit — scenarios + multiplier dumps.
 * Run: MONGO_URI=... pnpm exec ts-node --project tsconfig.scripts.json scripts/team-adjusted-improvement-audit.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import type { DraftedPlayer, LeanPlayer } from "../src/types/brain";
import { getPlayerId } from "../src/lib/playerId";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { playerTokensFromLean } from "../src/lib/fantasyRosterSlots";
import { isPitcherForBaseline } from "../src/services/baselineProjectionStats";

const NUM_TEAMS = 12;
const TOTAL_BUDGET = 260;
const USER = "team_1";

function mkDraft(p: LeanPlayer, team_id: string, paid = 3): DraftedPlayer {
  return {
    player_id: getPlayerId(p),
    name: p.name,
    position: p.position,
    team: p.team,
    team_id,
    paid,
  };
}

function roundRobin(pool: LeanPlayer[], nPicks: number, bid = 3): DraftedPlayer[] {
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

function team1Pick(
  pool: LeanPlayer[],
  n: number,
  pred: (p: LeanPlayer) => boolean,
  bid = 3,
  excludeIds?: Set<string>
): DraftedPlayer[] {
  const ex = excludeIds ?? new Set<string>();
  const sorted = [...pool].sort((a, b) => (b.value || 0) - (a.value || 0));
  const out: DraftedPlayer[] = [];
  for (const p of sorted) {
    if (out.length >= n) break;
    const id = getPlayerId(p);
    if (ex.has(id)) continue;
    if (!pred(p)) continue;
    ex.add(id);
    out.push(mkDraft(p, USER, bid));
  }
  return out;
}

function idsFromDraft(d: DraftedPlayer[]): Set<string> {
  return new Set(d.map((x) => x.player_id));
}

function tokens(p: LeanPlayer) {
  return playerTokensFromLean(p);
}

function isCatcher(p: LeanPlayer): boolean {
  return tokens(p).includes("C");
}

function isOF(p: LeanPlayer): boolean {
  const t = tokens(p);
  return t.some((x) => x === "OF" || x === "LF" || x === "CF" || x === "RF");
}

function isSP(p: LeanPlayer): boolean {
  return tokens(p).includes("SP");
}

function isRP(p: LeanPlayer): boolean {
  return tokens(p).includes("RP");
}

function isSS(p: LeanPlayer): boolean {
  return tokens(p).includes("SS");
}

/** Catalog-primary style — approximate roster construction */
function primaryLooksRP(p: LeanPlayer): boolean {
  const u = (p.position || "").toUpperCase();
  return u.includes("RP") && !u.includes("SP");
}

function primaryLooksSP(p: LeanPlayer): boolean {
  const u = (p.position || "").toUpperCase();
  return u.includes("SP") || u === "P";
}

type RowOut = {
  player_id: string;
  name: string;
  position: string;
  auction_value: number;
  team_adjusted_value: number;
  edge: number;
  recommended_bid?: number;
  team_multipliers?: Record<string, number | string>;
};

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function summarize(rows: RowOut[]) {
  const edges = rows.map((r) => r.edge);
  return {
    mean_edge: Number((edges.reduce((a, b) => a + b, 0) / edges.length).toFixed(4)),
    median_edge: median(edges),
    min_edge: rows.reduce((a, b) => (a.edge < b.edge ? a : b)),
    max_edge: rows.reduce((a, b) => (a.edge > b.edge ? a : b)),
    neg_edges_count: edges.filter((e) => e < -0.01).length,
  };
}

function topN(rows: RowOut[], key: keyof RowOut, n: number) {
  return [...rows]
    .filter((r) => typeof r[key] === "number")
    .sort((a, b) => (b[key] as number) - (a[key] as number))
    .slice(0, n)
    .map((r) => ({
      name: r.name,
      player_id: r.player_id,
      position: r.position,
      auction_value: r.auction_value,
      team_adjusted_value: r.team_adjusted_value,
      edge: r.edge,
    }));
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI ?? process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI required");

  await mongoose.connect(uri);
  let pool: LeanPlayer[];
  try {
    pool = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const base = {
    inflation_model: "replacement_slots_v2" as const,
    deterministic: true,
    seed: 42,
    user_team_id: USER,
  };

  const rr48 = roundRobin(pool, 48);
  const used48 = idsFromDraft(rr48);

  const scenarios: { id: string; extra: Record<string, unknown> }[] = [
    { id: "empty_symmetric", extra: { drafted_players: [] } },
    {
      id: "need_C_team1",
      extra: {
        drafted_players: [
          ...rr48,
          ...team1Pick(pool, 16, (p) => !isCatcher(p) && !isPitcherForBaseline(p), 3, new Set(used48)),
        ],
      },
    },
    {
      id: "need_SP_team1",
      extra: {
        drafted_players: (() => {
          const u = new Set(used48);
          const a = team1Pick(pool, 10, (p) => primaryLooksRP(p), 3, u);
          const b = team1Pick(pool, 12, (p) => !isPitcherForBaseline(p), 3, u);
          return [...rr48, ...a, ...b];
        })(),
      },
    },
    {
      id: "need_RP_team1",
      extra: {
        drafted_players: (() => {
          const u = new Set(used48);
          const a = team1Pick(
            pool,
            10,
            (p) => primaryLooksSP(p) && isPitcherForBaseline(p),
            3,
            u
          );
          const b = team1Pick(pool, 12, (p) => !isPitcherForBaseline(p), 3, u);
          return [...rr48, ...a, ...b];
        })(),
      },
    },
    {
      id: "need_OF_team1",
      extra: {
        drafted_players: [
          ...rr48,
          ...team1Pick(
            pool,
            18,
            (p) => !isOF(p) && !isPitcherForBaseline(p),
            3,
            new Set(used48)
          ),
        ],
      },
    },
    {
      id: "full_SS_team1",
      extra: {
        drafted_players: (() => {
          const u = new Set(used48);
          const a = team1Pick(pool, 2, (p) => isSS(p), 18, u);
          const b = team1Pick(pool, 14, (p) => !isSS(p), 3, u);
          return [...rr48, ...a, ...b];
        })(),
      },
    },
    {
      id: "low_budget_team1",
      extra: {
        drafted_players: rr48,
        budget_by_team_id: Object.fromEntries(
          Array.from({ length: NUM_TEAMS }, (_, i) => [
            `team_${i + 1}`,
            `team_${i + 1}` === USER ? 38 : TOTAL_BUDGET,
          ])
        ),
      },
    },
    {
      id: "high_budget_team1",
      extra: {
        drafted_players: rr48,
        budget_by_team_id: Object.fromEntries(
          Array.from({ length: NUM_TEAMS }, (_, i) => [
            `team_${i + 1}`,
            `team_${i + 1}` === USER ? 215 : TOTAL_BUDGET,
          ])
        ),
      },
    },
    {
      id: "many_cheap_keepers_team1",
      extra: {
        drafted_players: (() => {
          const u = new Set(used48);
          const cheapRows: DraftedPlayer[] = [];
          const cheapPool = pool.filter((p) => (p.value || 0) < 5);
          for (const p of cheapPool) {
            if (cheapRows.length >= 18) break;
            const id = getPlayerId(p);
            if (u.has(id)) continue;
            u.add(id);
            cheapRows.push({
              ...mkDraft(p, USER, 1),
              is_keeper: true as const,
              keeper_cost: 1,
            });
          }
          return [...rr48, ...cheapRows];
        })(),
      },
    },
    {
      id: "stars_few_dollars_team1",
      extra: {
        drafted_players: (() => {
          const sorted = [...pool].sort((a, b) => (b.value || 0) - (a.value || 0));
          const used = new Set(used48);
          const top2: DraftedPlayer[] = [];
          for (const p of sorted) {
            if (top2.length >= 2) break;
            const id = getPlayerId(p);
            if (used.has(id)) continue;
            used.add(id);
            top2.push(mkDraft(p, USER, 118));
          }
          const cheap: DraftedPlayer[] = [];
          for (const p of sorted) {
            if (cheap.length >= 14) break;
            const id = getPlayerId(p);
            if (used.has(id)) continue;
            used.add(id);
            cheap.push(mkDraft(p, USER, 2));
          }
          return [...rr48, ...top2, ...cheap];
        })(),
      },
    },
  ];

  const suspicious: string[] = [];

  const scenarioResults = scenarios.map((sc) => {
    const input = buildDraftroomStandardValuationInput({
      ...base,
      ...(sc.extra as object),
    });
    const wf = executeValuationWorkflow(pool, input, {}, { debugSignals: true });
    if (!wf.ok) {
      suspicious.push(`${sc.id}: workflow failed ${wf.issues.join("; ")}`);
      return { id: sc.id, ok: false };
    }

    const rows: RowOut[] = wf.response.valuations.map((v) => {
      const tm = v.debug_v2?.team_multipliers;
      return {
        player_id: v.player_id,
        name: v.name,
        position: v.position,
        auction_value: v.auction_value,
        team_adjusted_value: v.team_adjusted_value ?? v.auction_value,
        edge: (v.team_adjusted_value ?? v.auction_value) - v.auction_value,
        recommended_bid: v.recommended_bid,
        team_multipliers: tm as Record<string, number | string> | undefined,
      };
    });

    const poolById = new Map(pool.map((p) => [getPlayerId(p), p]));
    const sumry = summarize(rows);

    const topCatchers = rows
      .filter((r) => isCatcher(poolById.get(r.player_id)!))
      .sort((a, b) => b.edge - a.edge)
      .slice(0, 5)
      .map((r) => ({ name: r.name, edge: r.edge, auction_value: r.auction_value }));
    const topSS = rows
      .filter((r) => isSS(poolById.get(r.player_id)!))
      .sort((a, b) => b.edge - a.edge)
      .slice(0, 5)
      .map((r) => ({ name: r.name, edge: r.edge }));

    const starFew =
      sc.id === "stars_few_dollars_team1"
        ? rows.find((r) => r.name.includes("Tucker") || r.auction_value > 35)
        : undefined;

    const repPlayers = [
      rows.find((r) => isCatcher(poolById.get(r.player_id)!)),
      rows.find((r) => isSS(poolById.get(r.player_id)!)),
      rows.find((r) => isSP(poolById.get(r.player_id)!)),
      rows.find((r) => isRP(poolById.get(r.player_id)!)),
      rows.find((r) => isOF(poolById.get(r.player_id)!)),
    ].filter(Boolean) as RowOut[];

    if (sc.id === "empty_symmetric" && sumry.mean_edge !== 0) {
      suspicious.push("empty_symmetric: expected zero edge");
    }

    return {
      id: sc.id,
      ok: true,
      summary: sumry,
      top20_auction: topN(rows, "auction_value", 20),
      top20_team_adjusted: topN(rows, "team_adjusted_value", 20),
      top20_edge: topN(rows, "edge", 20),
      top_catchers_by_edge: topCatchers,
      top_ss_by_edge: topSS,
      representative_debug_multipliers: repPlayers.map((r) => ({
        name: r.name,
        position: r.position,
        auction_value: r.auction_value,
        edge: r.edge,
        team_multipliers: r.team_multipliers,
      })),
      star_sample_under_strain: starFew
        ? {
            name: starFew.name,
            auction_value: starFew.auction_value,
            team_adjusted_value: starFew.team_adjusted_value,
            edge: starFew.edge,
            team_multipliers: starFew.team_multipliers,
          }
        : undefined,
    };
  });

  console.log(
    JSON.stringify(
      {
        formula_reference: {
          team_adjusted_raw:
            "adjusted_value * need * budget * dollars_per_slot * slot_scarcity * replacement_dropoff",
          cap: "min(8000, max(adjusted_value*6, baseline_value*4 + adjusted_value))",
          need: {
            open_primary_fitting_slot: 1.25,
            open_flex_UTIL_CI_MI_P: 1.1,
            fits_some_starting_slot_but_primaries_flex_full: 0.85,
            else: 1.0,
            flex_slots: ["UTIL", "CI", "MI", "P"],
          },
          budget: {
            userRemaining_vs_leagueAvgRemaining:
              "> 1.25x avg -> 1.15; < 0.75x -> 0.85; else 1.0",
          },
          dollars_per_slot: {
            dpsRatio: "(userRemaining/openSeats) / (peerBudget/peerOpen)",
            if_ratio_gt_1_18: "1 + 0.14*min(2.2, ratio-1.18)",
            if_ratio_lt_0_82: "1 - 0.11*min(1.2, 0.82-ratio)",
            approximate_bounds: ["~0.868", "~1.308"],
          },
          slot_scarcity: {
            formula: "1 + 0.22 * (1 - openSeatTotal/userStartingCap)",
            bounds: "[1, 1.22] when openSeatTotal in [0, cap]",
          },
          replacement_dropoff: {
            formula:
              "drop = max over fitting slots of (baseline - repl[slot]); mult = 1 + 0.22*min(1.25, drop/max(8,baseline))",
            bounds: "[1, 1.275] approximately",
          },
        },
        scenarios: scenarioResults,
        suspicious,
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
