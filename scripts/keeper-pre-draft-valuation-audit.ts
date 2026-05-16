/**
 * Compare fresh open league vs pre-draft keeper fixture (replacement_slots_v2).
 * Requires MONGO_URI for catalog pool.
 *
 *   pnpm keeper-pre-draft-audit
 *
 * Writes tmp/keeper-pre-draft-valuation-audit.json
 */
import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import { buildRosteredPlayersForSlotEngine } from "../src/lib/rosteredPlayersForSlots";
import { getPlayerId } from "../src/lib/playerId";
import type { LeanPlayer, ValuedPlayer } from "../src/types/brain";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";

const ROOT = path.resolve(__dirname, "..");
const DRAFT_FIXTURE = path.resolve(
  ROOT,
  "../AmethystDraft/apps/api/test-fixtures/player-api/checkpoints/pre_draft.json"
);
const LOCAL_FIXTURE = path.join(
  ROOT,
  "test-fixtures/player-api/checkpoints/pre_draft.json"
);
const OUT = path.join(ROOT, "tmp", "keeper-pre-draft-valuation-audit.json");
const CHANDLER_SIMPSON_ID = "802415";
const TOP_N = 25;

type AuditRow = Record<string, unknown>;

function loadPreDraftFixture(): Record<string, unknown> {
  const p = [DRAFT_FIXTURE, LOCAL_FIXTURE].find((f) => {
    try {
      readFileSync(f, "utf8");
      return true;
    } catch {
      return false;
    }
  });
  if (!p) throw new Error("pre_draft.json not found in Draft or API fixtures");
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function rowToAudit(
  row: ValuedPlayer,
  poolById: Map<string, LeanPlayer>,
  rosterStatus: string
): AuditRow {
  const lp = poolById.get(row.player_id);
  const bc = row.baseline_components ?? {};
  const ex = row.valuation_explain ?? {};
  const meta = (
    lp?.projection as { __valuation_meta__?: Record<string, unknown> } | undefined
  )?.__valuation_meta__;
  return {
    player_id: row.player_id,
    name: row.name,
    position: row.position,
    replacement_slot: ex.replacement_key ?? ex.replacement_slot ?? null,
    baseline_value: row.baseline_value,
    auction_value: row.auction_value,
    adjusted_value: row.adjusted_value,
    recommended_bid: row.recommended_bid,
    team_value: row.team_adjusted_value,
    surplus_basis: ex.surplus_basis ?? row.debug_v2?.surplus_basis,
    scarcity_component: num(bc.scarcity_component),
    projection_component: num(bc.projection_component),
    age_depth_component: num(bc.age_depth_component ?? ex.age_component),
    injury_component: num(bc.injury_component ?? ex.injury_component),
    inflation_factor_row: row.inflation_factor,
    inflation_adjustment: row.inflation_adjustment,
    replacement_value_used: ex.replacement_value_used,
    roster_status: rosterStatus,
    pool_slot_ratio: meta?.pool_slot_ratio ?? null,
  };
}

function topRows(
  valuations: ValuedPlayer[],
  poolById: Map<string, LeanPlayer>,
  status: string
): AuditRow[] {
  return [...valuations]
    .sort((a, b) => b.auction_value - a.auction_value)
    .slice(0, TOP_N)
    .map((r) => rowToAudit(r, poolById, status));
}

function marketSummary(
  valuations: ValuedPlayer[],
  poolById: Map<string, LeanPlayer>,
  v2: {
    remaining_slots?: number;
    surplus_cash?: number;
    total_surplus_mass?: number;
    min_bid?: number;
  },
  inflationFactor: number,
  totalBudgetRemaining: number
) {
  const remainingSlots = v2.remaining_slots ?? 0;
  const minBid = v2.min_bid ?? 1;
  const minReserve = remainingSlots * minBid;
  const surplusCash = v2.surplus_cash ?? 0;
  const positiveSurplus = valuations.filter(
    (r) => num(r.valuation_explain?.surplus_basis ?? r.debug_v2?.surplus_basis) > 0
  ).length;
  return {
    remaining_active_slots_league: remainingSlots,
    total_budget_remaining: totalBudgetRemaining,
    minimum_reserve_dollars: minReserve,
    surplus_cash,
    allocatable_surplus_dollars: surplusCash,
    inflation_factor: inflationFactor,
    total_surplus_mass: v2.total_surplus_mass ?? 0,
    available_positive_surplus_players: positiveSurplus,
    undrafted_valuation_row_count: valuations.length,
  };
}

async function loadPool(): Promise<LeanPlayer[]> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required");
  await mongoose.connect(uri, scriptMongoConnectOptions());
  try {
    return await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

async function runScenario(
  label: string,
  input: ReturnType<typeof buildDraftroomStandardValuationInput>,
  pool: LeanPlayer[]
) {
  const poolById = new Map(pool.map((p) => [getPlayerId(p), p]));
  const body = {
    ...input,
    explain_valuation_rows: true,
    inflation_model: "replacement_slots_v2" as const,
    deterministic: true,
    seed: 42,
  };
  const result = executeValuationWorkflow(pool, body, {}, {});
  if (!result.ok) {
    throw new Error(`${label}: ${result.issues?.join("; ")}`);
  }
  const resp = result.response!;
  const rostered = buildRosteredPlayersForSlotEngine(body);
  const cap = body.roster_slots.reduce((s, r) => s + r.count, 0) * body.num_teams;
  const budgetRemaining =
    (resp.surplus_cash ?? 0) +
    (resp.remaining_slots ?? 0) * (resp.min_bid ?? 1);

  const top = topRows(resp.valuations, poolById, "available");
  const chandler = resp.valuations.find((v) => v.player_id === CHANDLER_SIMPSON_ID);

  return {
    label,
    market: {
      ...marketSummary(
        resp.valuations,
        poolById,
        {
          remaining_slots: resp.remaining_slots,
          surplus_cash: resp.surplus_cash,
          total_surplus_mass: resp.total_surplus_mass,
          min_bid: resp.min_bid,
        },
        resp.inflation_factor,
        budgetRemaining
      ),
      league_active_slot_capacity: cap,
      top_25: top,
      rostered_for_slots_count: rostered.length,
    },
    chandler_simpson: chandler
      ? rowToAudit(chandler, poolById, "available")
      : null,
  };
}

async function main(): Promise<void> {
  const pool = await loadPool();
  const raw = loadPreDraftFixture();
  const parsed = nestedValuationBodySchema.parse(raw);
  const keeperInput = buildNormalizedFromNested(parsed);
  keeperInput.explain_valuation_rows = true;
  keeperInput.inflation_model = "replacement_slots_v2";
  keeperInput.deterministic = true;
  keeperInput.seed = 42;

  const freshInput = buildDraftroomStandardValuationInput({
    num_teams: keeperInput.num_teams,
    total_budget: keeperInput.total_budget,
    roster_slots: keeperInput.roster_slots,
    scoring_categories: keeperInput.scoring_categories,
    league_scope: keeperInput.league_scope,
    scoring_format: keeperInput.scoring_format,
    drafted_players: [],
    pre_draft_rosters: undefined,
    minors: undefined,
    taxi: undefined,
    budget_by_team_id: undefined,
  });

  const fresh = await runScenario("fresh_9_team_no_keepers", freshInput, pool);
  const keeper = await runScenario("pre_draft_keeper_fixture", keeperInput, pool);

  const out = {
    generated_at: new Date().toISOString(),
    chandler_simpson_player_id: CHANDLER_SIMPSON_ID,
    scenarios: [fresh, keeper],
    notes: [
      "MIN/TAXI excluded from buildRosteredPlayersForSlotEngine (active slot demand).",
      "MIN/TAXI still in additionalDraftedIds (off auction pool).",
      "recommended_bid may exceed auction_value by clearing-price design.",
    ],
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT}`);
  for (const s of out.scenarios) {
    console.log(`\n=== ${s.label} ===`);
    console.log(
      `inflation_factor=${s.market.inflation_factor} remaining_slots=${s.market.remaining_active_slots_league} surplus_cash=${s.market.surplus_cash} rostered_for_slots=${s.market.rostered_for_slots_count}`
    );
    if (s.chandler_simpson) {
      console.log(
        `Chandler Simpson: auction=${s.chandler_simpson.auction_value} recommended=${s.chandler_simpson.recommended_bid} baseline=${s.chandler_simpson.baseline_value} surplus_basis=${s.chandler_simpson.surplus_basis}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
