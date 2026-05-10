/**
 * One-off audit: two-way (Shohei-style) valuation — catalog discovery + scenario matrix.
 *
 *   AMETHYST_SKIP_MLB_TEAM_HYDRATE=1 npx ts-node --project tsconfig.scripts.json scripts/two-way-valuation-audit.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import type { LeanPlayer, NormalizedValuationInput, RosterSlot, ValuedPlayer } from "../src/types/brain";
import { loadMongoCatalogForEngine } from "../src/lib/mongoCatalogPipeline";
import {
  buildDraftroomStandardValuationInput,
  CALIBRATION_CATS_5X5,
  draftroomUiDefaultRoster,
} from "../src/lib/calibrationDraftroomFixture";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import { filterValuationUniverse } from "../src/lib/valuationPlayerPool";
import { getPlayerId } from "../src/lib/playerId";
import { playerTokensFromLean } from "../src/lib/fantasyRosterSlots";
import {
  isPitcherForBaseline,
  isTwoWayEligibleForBaseline,
} from "../src/services/baselineProjectionStats";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";

function hasSection(obj: unknown, keys: string[]): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return keys.some((k) => {
    const v = o[k];
    if (typeof v === "number") return Number.isFinite(v) && v > 0;
    if (typeof v === "string") {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0;
    }
    return false;
  });
}

function hasBatAndPitchProjections(p: LeanPlayer): boolean {
  const proj = p.projection as Record<string, unknown> | undefined;
  if (!proj) return false;
  const bat = proj.batting as Record<string, unknown> | undefined;
  const pit = proj.pitching as Record<string, unknown> | undefined;
  const batOk = hasSection(bat, ["hr", "atBats", "ab", "runs", "rbi", "sb"]);
  const pitOk = hasSection(pit, [
    "strikeouts",
    "innings",
    "inningsPitched",
    "ip",
    "wins",
    "saves",
    "era",
  ]);
  return batOk && pitOk;
}

function tokensIncludeDhPlusPitch(tokens: string[]): boolean {
  const hasDh = tokens.includes("DH");
  const hasPitch = tokens.some((t) => t === "SP" || t === "RP" || t === "P");
  return hasDh && hasPitch;
}

function rosterNoUtil(slots: RosterSlot[]): RosterSlot[] {
  return slots
    .map((s) =>
      s.position.toUpperCase() === "UTIL"
        ? { ...s, count: 0 }
        : s
    )
    .filter((s) => s.count > 0);
}

function rosterWithExtraP(slots: RosterSlot[]): RosterSlot[] {
  const copy = slots.map((s) => ({ ...s }));
  const pIdx = copy.findIndex((s) => s.position.toUpperCase() === "P");
  if (pIdx >= 0) copy[pIdx]!.count += 2;
  else copy.push({ position: "P", count: 2 });
  return copy;
}

function runScenarioMap(
  label: string,
  universe: LeanPlayer[],
  input: NormalizedValuationInput,
  ids: Set<string>
): Map<string, ValuedPlayer> {
  const res = executeValuationWorkflow(universe, input, {});
  const out = new Map<string, ValuedPlayer>();
  if (!res.ok) {
    console.error(label, res.issues);
    return out;
  }
  for (const v of res.response.valuations) {
    if (ids.has(v.player_id)) out.set(v.player_id, v);
  }
  return out;
}

function pickRowFields(v: ValuedPlayer) {
  const ex = v.valuation_explain;
  const bc = v.baseline_components;
  return {
    player_id: v.player_id,
    baseline_value: v.baseline_value,
    auction_value: v.auction_value,
    recommended_bid: v.recommended_bid,
    team_adjusted_value: v.team_adjusted_value,
    replacement_key_used: ex?.replacement_key_used ?? v.debug_v2?.replacement_key_used,
    replacement_value_used: ex?.replacement_value_used ?? v.debug_v2?.replacement_value_used,
    surplus_basis: ex?.surplus_basis ?? v.debug_v2?.surplus_basis,
    inflation_factor: ex?.inflation_factor ?? v.inflation_factor,
    two_way_role_selected: bc?.two_way_role_selected ?? ex?.two_way_role_selected,
    hitter_baseline_candidate: bc?.hitter_baseline_candidate ?? ex?.hitter_baseline_candidate,
    pitcher_baseline_candidate: bc?.pitcher_baseline_candidate ?? ex?.pitcher_baseline_candidate,
  };
}

async function main() {
  const uri = process.env.MONGO_URI ?? process.env.MONGODB_URI;
  if (!uri) {
    console.error("Set MONGO_URI (or MONGODB_URI) for catalog audit.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const pool = await loadMongoCatalogForEngine(undefined, { skipMlbHydration: true });
  await mongoose.disconnect();

  const universe = filterValuationUniverse(pool, { leagueScope: "Mixed" });

  const twpPrimary = universe.filter((p) => p.position?.trim().toUpperCase() === "TWP");
  const bothProj = universe.filter(hasBatAndPitchProjections);
  const tokenized = universe.map((p) => ({
    p,
    tokens: playerTokensFromLean(p),
  }));
  const dhPitchTok = tokenized.filter(({ tokens }) => tokensIncludeDhPlusPitch(tokens));

  const byName = new Map<string, LeanPlayer[]>();
  for (const p of universe) {
    const k = p.name.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(p);
  }
  const dupNames = [...byName.entries()].filter(([, arr]) => arr.length > 1);

  console.log("=== Catalog discovery (Mixed scope) ===\n");
  console.log(`Total valuation-eligible rows: ${universe.length}`);
  console.log(`Primary position TWP: ${twpPrimary.length}`);
  console.log(`Both batting + pitching projection sections (heuristic): ${bothProj.length}`);
  console.log(`Tokens include DH and SP/RP/P: ${dhPitchTok.length}`);
  console.log(`Duplicate player names (multiple rows): ${dupNames.length}`);

  const candidateIds = new Set<string>();
  for (const p of twpPrimary) candidateIds.add(getPlayerId(p));
  for (const p of bothProj) candidateIds.add(getPlayerId(p));
  for (const { p } of dhPitchTok) candidateIds.add(getPlayerId(p));

  const candidates = universe.filter((p) => candidateIds.has(getPlayerId(p)));
  const sorted = [...candidates].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  console.log(`\nUnion candidate count (TWP ∪ dual projection ∪ DH+pitch tokens): ${sorted.length}\n`);

  const baseIn = buildDraftroomStandardValuationInput({
    explain_valuation_rows: true,
    user_team_id: "audit-team",
  });

  const inspect = sorted.slice(0, 12);
  const idSet = new Set(inspect.map((p) => getPlayerId(p)));

  const maps = {
    A_default: runScenarioMap("A_default_draftroom", universe, baseIn, idSet),
    B_P_slots: runScenarioMap(
      "B_generic_P_slots",
      universe,
      { ...baseIn, roster_slots: rosterWithExtraP(draftroomUiDefaultRoster()) },
      idSet
    ),
    C_no_UTIL: runScenarioMap(
      "C_no_UTIL",
      universe,
      { ...baseIn, roster_slots: rosterNoUtil(draftroomUiDefaultRoster()) },
      idSet
    ),
  };

  const perPlayerPitchOverride = new Map<string, NormalizedValuationInput>();
  const perPlayerHitOverride = new Map<string, NormalizedValuationInput>();
  for (const p of inspect) {
    const id = getPlayerId(p);
    perPlayerHitOverride.set(id, {
      ...baseIn,
      position_overrides: [{ player_id: id, positions: ["DH"] }],
    });
    perPlayerPitchOverride.set(id, {
      ...baseIn,
      position_overrides: [{ player_id: id, positions: ["SP"] }],
    });
  }

  for (const p of inspect) {
    const id = getPlayerId(p);
    const tokens = playerTokensFromLean(p);
    const baselineRole = isTwoWayEligibleForBaseline(p)
      ? "two_way_max(hit,pitch)"
      : isPitcherForBaseline(p)
        ? "pitcher_only_baseline"
        : "hitter_only_baseline";

    const hitMap = runScenarioMap(
      "D_hitter_only_override",
      universe,
      perPlayerHitOverride.get(id)!,
      new Set([id])
    );
    const pitchMap = runScenarioMap(
      "E_pitcher_only_override",
      universe,
      perPlayerPitchOverride.get(id)!,
      new Set([id])
    );

    console.log("—".repeat(72));
    console.log(`player_id=${id} name=${p.name} mlbId=${p.mlbId ?? "—"}`);
    console.log(`position=${p.position} positions=${JSON.stringify(p.positions ?? [])}`);
    console.log(`effective_tokens=${JSON.stringify(tokens)}`);
    console.log(`baseline_engine_branch: ${baselineRole} (isPitcherForBaseline)`);
    console.log(
      `UTIL_eligible=${tokens.some((t) => ["C", "1B", "2B", "3B", "SS", "OF", "DH", "CI", "MI"].includes(t))} (fits UTIL if hitter token)`
    );
    console.log(
      `P_slot_eligible=${tokens.includes("SP") || tokens.includes("RP") || tokens.includes("P")}`
    );

    const proj = p.projection as Record<string, unknown> | undefined;
    console.log(
      `batting_proj_keys_sample=${Object.keys((proj?.batting as object) ?? {}).slice(0, 8).join(",")}`
    );
    console.log(
      `pitching_proj_keys_sample=${Object.keys((proj?.pitching as object) ?? {}).slice(0, 8).join(",")}`
    );

    const scenRows: [string, ValuedPlayer | undefined][] = [
      ["A_default_draftroom", maps.A_default.get(id)],
      ["B_generic_P_slots", maps.B_P_slots.get(id)],
      ["C_no_UTIL", maps.C_no_UTIL.get(id)],
      ["D_hitter_only_override", hitMap.get(id)],
      ["E_pitcher_only_override", pitchMap.get(id)],
    ];
    for (const [lab, row] of scenRows) {
      if (!row) console.log(`  [${lab}] MISSING ROW`);
      else console.log(`  [${lab}] ${JSON.stringify(pickRowFields(row))}`);
    }
  }

  if (dupNames.length > 0) {
    console.log("\n=== Sample duplicate names (first 15) ===\n");
    for (const [name, rows] of dupNames.slice(0, 15)) {
      console.log(
        `${name}: ${rows
          .map((r) => `${getPlayerId(r)} pos=${r.position} mlbId=${r.mlbId}`)
          .join(" | ")}`
      );
    }
  }

  // Synthetic sanity: dual-eligibility lean player (matches unit test spirit)
  const synthetic: LeanPlayer = {
    _id: "synthetic-tw-audit",
    mlbId: 660271,
    name: "Synthetic Ohtani-shaped",
    team: "LAD",
    position: "DH",
    positions: ["SP", "DH"],
    catalog_rank: 1,
    catalog_tier: 1,
    value: 45,
    projection: {
      batting: { hr: 35, rbi: 85, runs: 95, sb: 15, avg: 0.29, atBats: 520 },
      pitching: { strikeouts: 180, wins: 12, saves: 0, era: 3.2, whip: 1.05, innings: 120 },
    },
  };
  const [synCombined, synHit, synPitch] = [
    scoringAwareBaselinePlayers(
      [synthetic],
      "5x5",
      CALIBRATION_CATS_5X5,
      draftroomUiDefaultRoster()
    )[0]!,
    scoringAwareBaselinePlayers(
      [{ ...synthetic, positions: ["DH"] }],
      "5x5",
      CALIBRATION_CATS_5X5,
      draftroomUiDefaultRoster()
    )[0]!,
    scoringAwareBaselinePlayers(
      [{ ...synthetic, position: "SP", positions: ["SP"] }],
      "5x5",
      CALIBRATION_CATS_5X5,
      draftroomUiDefaultRoster()
    )[0]!,
  ];
  console.log("\n=== Synthetic two-way (local, no Mongo) — baseline_value only ===\n");
  console.log(`combined DH+SP tokens: ${synCombined.value} (pitcher z-pool)`);
  console.log(`hitter-only DH: ${synHit.value} (hitter z-pool)`);
  console.log(`pitcher-only SP: ${synPitch.value} (pitcher z-pool)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
