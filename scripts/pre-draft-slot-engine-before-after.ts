/**
 * Before/after audit: legacy slot engine (keepers+minors+taxi) vs fixed (keepers only).
 *
 *   pnpm pre-draft-before-after
 *
 * Requires MONGO_URI (.env). Writes tmp/pre-draft-slot-engine-before-after.json
 */
import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import {
  buildRosteredPlayersForSlotEngine,
  isReserveRosterSlotForEngine,
} from "../src/lib/rosteredPlayersForSlots";
import { applyInjuryOverridesToPool } from "../src/lib/valuationInjuryOverrides";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { positionOverridesFromRequest } from "../src/lib/fantasyRosterSlots";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { calculateInflation } from "../src/services/inflationEngine";
import { attachValuationExplainability } from "../src/lib/valuationExplainability";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import type {
  DraftedPlayer,
  LeanPlayer,
  NormalizedValuationInput,
  ValuedPlayer,
  ValuationResponse,
} from "../src/types/brain";
import { getPlayerId } from "../src/lib/playerId";

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATHS = [
  path.resolve(ROOT, "../AmethystDraft/apps/api/test-fixtures/player-api/checkpoints/pre_draft.json"),
  path.join(ROOT, "test-fixtures/player-api/checkpoints/pre_draft.json"),
];
const OUT = path.join(ROOT, "tmp", "pre-draft-slot-engine-before-after.json");
const CHANDLER_ID = "802415";
const TOP_N = 25;

/** Legacy slot engine: auction + keepers + minors + taxi (pre-fix bug). */
function buildRosteredPlayersForSlotEngineLegacy(
  input: NormalizedValuationInput
): DraftedPlayer[] {
  const current = buildRosteredPlayersForSlotEngine(input);
  const byId = new Map(current.map((d) => [d.player_id, d]));

  const collectBuckets = (
    buckets: NormalizedValuationInput["minors"] | NormalizedValuationInput["taxi"]
  ) => {
    if (!buckets) return;
    const sections = Array.isArray(buckets) ? buckets : Object.values(buckets);
    for (const section of sections) {
      const rows = Array.isArray(section)
        ? section
        : (section as { players?: unknown[] }).players;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (typeof row !== "object" || row == null) continue;
        const rec = row as Record<string, unknown>;
        const pid = rec.player_id;
        if (typeof pid !== "string" || !pid) continue;
        if (byId.has(pid)) continue;
        const position =
          typeof rec.position === "string" && rec.position.length > 0
            ? rec.position
            : "OF";
        byId.set(pid, {
          player_id: pid,
          name: typeof rec.name === "string" ? rec.name : pid,
          position,
          team: typeof rec.team === "string" ? rec.team : "",
          team_id: typeof rec.team_id === "string" ? rec.team_id : "",
          roster_slot:
            typeof rec.roster_slot === "string" ? rec.roster_slot : undefined,
        });
      }
    }
  };
  collectBuckets(input.minors);
  collectBuckets(input.taxi);
  return [...byId.values()];
}

function extractPoolRemoval(input: NormalizedValuationInput): {
  unavailable_player_ids: string[];
  keeper_count: number;
  minors_count: number;
  taxi_count: number;
} {
  const ids = new Set<string>();
  let keepers = 0;
  let minors = 0;
  let taxi = 0;

  const scan = (rows: unknown[] | undefined, kind: "keeper" | "minor" | "taxi" | "other") => {
    for (const row of rows ?? []) {
      if (typeof row !== "object" || row == null) continue;
      const rec = row as Record<string, unknown>;
      const pid = rec.player_id;
      if (typeof pid === "string" && pid) ids.add(pid);
      if (kind === "keeper") keepers++;
      if (kind === "minor") minors++;
      if (kind === "taxi") taxi++;
    }
  };

  if (input.pre_draft_rosters) {
    for (const rows of Object.values(input.pre_draft_rosters)) {
      scan(Array.isArray(rows) ? rows : [], "keeper");
    }
  }
  const scanBuckets = (
    buckets: NormalizedValuationInput["minors"] | NormalizedValuationInput["taxi"],
    kind: "minor" | "taxi"
  ) => {
    if (!buckets) return;
    const sections = Array.isArray(buckets) ? buckets : Object.values(buckets);
    for (const section of sections) {
      const rows = Array.isArray(section)
        ? section
        : (section as { players?: unknown[] }).players;
      scan(rows, kind);
    }
  };
  scanBuckets(input.minors, "minor");
  scanBuckets(input.taxi, "taxi");
  for (const d of input.drafted_players) ids.add(d.player_id);

  return {
    unavailable_player_ids: [...ids],
    keeper_count: keepers,
    minors_count: minors,
    taxi_count: taxi,
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function topAuctionRows(valuations: ValuedPlayer[]) {
  return [...valuations]
    .sort((a, b) => b.auction_value - a.auction_value)
    .slice(0, TOP_N)
    .map((r) => ({
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      auction_value: r.auction_value,
      recommended_bid: r.recommended_bid,
      baseline_value: r.baseline_value,
      replacement_slot: r.valuation_explain?.replacement_key_used ?? null,
      surplus_basis: r.valuation_explain?.surplus_basis ?? r.debug_v2?.surplus_basis,
    }));
}

function chandlerRow(valuations: ValuedPlayer[]) {
  const r = valuations.find((v) => v.player_id === CHANDLER_ID);
  if (!r) return null;
  return {
    player_id: r.player_id,
    name: r.name,
    auction_value: r.auction_value,
    recommended_bid: r.recommended_bid,
    baseline_value: r.baseline_value,
    team_value: r.team_adjusted_value,
    replacement_slot: r.valuation_explain?.replacement_key_used ?? null,
    surplus_basis: r.valuation_explain?.surplus_basis,
    inflation_factor_row: r.inflation_factor,
    scarcity_component: r.baseline_components?.scarcity_component,
    projection_component: r.baseline_components?.projection_component,
  };
}

function summarizeMarket(resp: ValuationResponse) {
  const remaining = resp.remaining_slots ?? 0;
  const minBid = resp.min_bid ?? 1;
  const minReserve = remaining * minBid;
  const surplusCash = resp.surplus_cash ?? 0;
  const budgetRemaining =
    surplusCash + minReserve;
  return {
    remaining_active_slots: remaining,
    remaining_auction_dollars: budgetRemaining,
    minimum_reserve_dollars: minReserve,
    allocatable_surplus_dollars: surplusCash,
    surplus_allocation_factor: resp.inflation_factor,
    total_surplus_mass: resp.total_surplus_mass,
    undrafted_valuation_rows: resp.valuations.length,
  };
}

function runScenario(
  label: "before_legacy_slot_engine" | "after_fixed_slot_engine",
  input: NormalizedValuationInput,
  basePlayers: LeanPlayer[],
  rostered: DraftedPlayer[],
  extra: { additionalSpent: number; additionalDraftedIds: string[] }
): {
  label: string;
  slot_engine_rostered_count: number;
  market: ReturnType<typeof summarizeMarket>;
  top_25_auction_values: ReturnType<typeof topAuctionRows>;
  chandler_simpson: ReturnType<typeof chandlerRow>;
} {
  const response = calculateInflation(
    basePlayers,
    input.drafted_players,
    input.total_budget,
    input.num_teams,
    input.roster_slots,
    input.league_scope,
    {
      deterministic: true,
      seed: 42,
      budgetByTeamId: input.budget_by_team_id,
      userTeamId: input.user_team_id ?? "team_1",
      additionalSpent: extra.additionalSpent,
      additionalDraftedIds: extra.additionalDraftedIds,
      inflationModel: "replacement_slots_v2",
      inflationCap: 3,
      inflationFloor: 0.25,
      rosteredPlayersForSlots: rostered,
      explainValuationRows: true,
      positionOverrides: positionOverridesFromRequest(input.position_overrides),
    }
  );

  const explained = attachValuationExplainability(response, input, basePlayers);

  return {
    label,
    slot_engine_rostered_count: rostered.length,
    market: summarizeMarket(explained),
    top_25_auction_values: topAuctionRows(explained.valuations),
    chandler_simpson: chandlerRow(explained.valuations),
  };
}

function extractDraftedIdsAndSpend(input: NormalizedValuationInput) {
  const ids = new Set<string>();
  let spent = 0;
  const collect = (rows: unknown[] | undefined) => {
    for (const row of rows ?? []) {
      if (typeof row !== "object" || row == null) continue;
      const rec = row as Record<string, unknown>;
      const pid = rec.player_id;
      if (typeof pid === "string" && pid) ids.add(pid);
      const kc = rec.keeper_cost;
      const paid = rec.paid;
      if (typeof kc === "number" && Number.isFinite(kc)) spent += kc;
      else if (typeof paid === "number" && Number.isFinite(paid)) spent += paid;
    }
  };
  if (input.pre_draft_rosters) {
    for (const rows of Object.values(input.pre_draft_rosters)) {
      collect(Array.isArray(rows) ? rows : []);
    }
  }
  const buckets = (b: NormalizedValuationInput["minors"] | NormalizedValuationInput["taxi"]) => {
    if (!b) return;
    const sections = Array.isArray(b) ? b : Object.values(b);
    for (const s of sections) {
      const rows = Array.isArray(s) ? s : (s as { players?: unknown[] }).players;
      collect(rows);
    }
  };
  buckets(input.minors);
  buckets(input.taxi);
  return { additionalSpent: spent, additionalDraftedIds: [...ids] };
}

async function main(): Promise<void> {
  const fixturePath = FIXTURE_PATHS.find((p) => {
    try {
      readFileSync(p, "utf8");
      return true;
    } catch {
      return false;
    }
  });
  if (!fixturePath) throw new Error("pre_draft.json not found");

  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  const parsed = nestedValuationBodySchema.parse(raw);
  const input = buildNormalizedFromNested(parsed);
  input.explain_valuation_rows = true;
  input.inflation_model = "replacement_slots_v2";
  input.deterministic = true;
  input.seed = 42;

  const slotsPerTeam = input.roster_slots.reduce((s, r) => s + r.count, 0);
  const leagueCapacity = slotsPerTeam * input.num_teams;
  const pool = extractPoolRemoval(input);
  const extra = extractDraftedIdsAndSpend(input);

  const rosteredBefore = buildRosteredPlayersForSlotEngineLegacy(input);
  const rosteredAfter = buildRosteredPlayersForSlotEngine(input);
  const activeKeepersOnly = rosteredAfter.filter(
    (r) => !isReserveRosterSlotForEngine(r.roster_slot)
  );

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI required (see .env)");

  await mongoose.connect(uri, scriptMongoConnectOptions());
  let catalog: LeanPlayer[];
  try {
    catalog = await loadMongoCatalogForEngine(undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  const valuationPool = filterValuationUniverse(catalog, {
    leagueScope: input.league_scope,
    eligiblePlayerIds: input.eligible_player_ids,
    excludedPlayerIds: input.excluded_player_ids,
  });
  const poolWithInjury = applyInjuryOverridesToPool(
    valuationPool,
    input.injury_overrides
  );
  const positionOverrides = positionOverridesFromRequest(input.position_overrides);
  const basePlayers = scoringAwareBaselinePlayers(
    poolWithInjury,
    input.scoring_format,
    input.scoring_categories,
    input.roster_slots,
    positionOverrides
  );

  const before = runScenario(
    "before_legacy_slot_engine",
    input,
    basePlayers,
    rosteredBefore,
    extra
  );
  const after = runScenario(
    "after_fixed_slot_engine",
    input,
    basePlayers,
    rosteredAfter,
    extra
  );

  const expectedRemaining = leagueCapacity - pool.keeper_count;
  const anchorOk =
    Math.abs(after.market.remaining_active_slots - expectedRemaining) <= 2;

  const out = {
    generated_at: new Date().toISOString(),
    fixture: path.basename(fixturePath),
    anchor: {
      slots_per_team: slotsPerTeam,
      num_teams: input.num_teams,
      league_active_slot_capacity: leagueCapacity,
      keeper_count_fixture: pool.keeper_count,
      minors_count_fixture: pool.minors_count,
      taxi_count_fixture: pool.taxi_count,
      expected_remaining_active_slots_if_one_keeper_per_slot:
        expectedRemaining,
      after_remaining_active_slots: after.market.remaining_active_slots,
      anchor_113_passes: anchorOk,
    },
    pool_removal: {
      unavailable_from_auction_pool_count: pool.unavailable_player_ids.length,
      ...pool,
    },
    slot_engine_rostered: {
      before_count: rosteredBefore.length,
      after_count: rosteredAfter.length,
      after_active_keepers_plus_draft_only: activeKeepersOnly.length,
    },
    before,
    after,
    deltas: {
      remaining_active_slots: after.market.remaining_active_slots - before.market.remaining_active_slots,
      surplus_allocation_factor:
        after.market.surplus_allocation_factor -
        before.market.surplus_allocation_factor,
      allocatable_surplus_dollars:
        after.market.allocatable_surplus_dollars -
        before.market.allocatable_surplus_dollars,
      chandler_auction_value:
        num(after.chandler_simpson?.auction_value) -
        num(before.chandler_simpson?.auction_value),
    },
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log(`Wrote ${OUT}\n`);
  console.log("ANCHOR");
  console.log(
    `  capacity=${leagueCapacity} keepers=${pool.keeper_count} expected_remaining≈${expectedRemaining} after_remaining=${after.market.remaining_active_slots} pass=${anchorOk}`
  );
  console.log("\nSLOT ENGINE ROSTERED");
  console.log(`  before=${rosteredBefore.length} after=${rosteredAfter.length} (expect after≈${pool.keeper_count})`);
  console.log("\nPOOL");
  console.log(
    `  unavailable=${pool.unavailable_player_ids.length} (keepers+minors+taxi+auction)`
  );
  console.log("\nMARKET");
  for (const s of [before, after] as const) {
    const m = s.market;
    console.log(
      `  ${s.label}: remaining_slots=${m.remaining_active_slots} surplus_factor=${m.surplus_allocation_factor} surplus_cash=${m.allocatable_surplus_dollars} min_reserve=${m.minimum_reserve_dollars}`
    );
  }
  console.log("\nCHANDLER SIMPSON");
  console.log(`  before auction=${before.chandler_simpson?.auction_value} slot=${before.chandler_simpson?.replacement_slot}`);
  console.log(`  after  auction=${after.chandler_simpson?.auction_value} slot=${after.chandler_simpson?.replacement_slot}`);
  console.log("\nTOP 3 AFTER");
  for (const r of after.top_25_auction_values.slice(0, 3)) {
    console.log(`  ${r.name} $${r.auction_value}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
