/**
 * Isolation validation: Draftroom-shaped position_overrides consumption by Engine.
 * Does not require Draftroom repo — proves schema → normalization → token pipeline → economics.
 */
import { describe, expect, it } from "vitest";
import {
  effectiveFantasyTokens,
  fitsRosterSlot,
  maxSurplusOverSlots,
  playerTokensFromDrafted,
  playerTokensFromLean,
  positionOverridesFromRequest,
} from "../src/lib/fantasyRosterSlots";
import { buildNormalizedFromFlat } from "../src/lib/valuationRequestNormalization";
import { flatValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { calculateInflation } from "../src/services/inflationEngine";
import { buildPositionScarcity } from "../src/services/scarcityHelpers";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type {
  DraftedPlayer,
  LeanPlayer,
  NormalizedValuationInput,
  RosterSlot,
  ScoringCategory,
} from "../src/types/brain";

/** Exact Draftroom-style fragment under test */
const DRAFTROOM_OVERRIDE_FRAGMENT = [
  { player_id: "123", positions: ["2B", "OF"] },
] as const;

const cats5x5: ScoringCategory[] = [
  { name: "R", type: "batting" },
  { name: "HR", type: "batting" },
  { name: "RBI", type: "batting" },
  { name: "SB", type: "batting" },
  { name: "AVG", type: "batting" },
  { name: "W", type: "pitching" },
  { name: "SV", type: "pitching" },
  { name: "ERA", type: "pitching" },
  { name: "WHIP", type: "pitching" },
  { name: "K", type: "pitching" },
];

function mkLean(id: number, value: number, position: string, tier = 2): LeanPlayer {
  return {
    _id: `mongo_${id}`,
    mlbId: id,
    name: `Player ${id}`,
    team: "NYY",
    position,
    positions: position.includes(",") ? undefined : [position],
    catalog_rank: id,
    tier,
    value,
  };
}

const det = { deterministic: true, seed: 1 } as const;

describe("Draftroom contract: position_overrides isolation", () => {
  it("1–2: flat schema accepts Draftroom-shaped position_overrides", () => {
    const body = {
      roster_slots: [{ position: "OF", count: 3 }],
      scoring_categories: [{ name: "HR", type: "batting" }],
      total_budget: 260,
      drafted_players: [],
      position_overrides: [...DRAFTROOM_OVERRIDE_FRAGMENT],
    };
    const parsed = flatValuationBodySchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.position_overrides).toEqual([
      { player_id: "123", positions: ["2B", "OF"] },
    ]);
  });

  it("3: normalization preserves position_overrides", () => {
    const parsed = flatValuationBodySchema.parse({
      roster_slots: [{ position: "OF", count: 3 }],
      scoring_categories: [{ name: "HR", type: "batting" }],
      total_budget: 260,
      drafted_players: [],
      position_overrides: [...DRAFTROOM_OVERRIDE_FRAGMENT],
    });
    const n = buildNormalizedFromFlat(parsed);
    expect(n.position_overrides).toEqual([
      { player_id: "123", positions: ["2B", "OF"] },
    ]);
  });

  it("4–5–12: effectiveFantasyTokens / lean / drafted respect player_id string MLB id 123", () => {
    const lean = mkLean(123, 30, "SS");
    lean.positions = ["SS", "OF"]; // catalog secondary OF — override must win (see next test)
    const ov = positionOverridesFromRequest([...DRAFTROOM_OVERRIDE_FRAGMENT]);
    expect(effectiveFantasyTokens(lean, ov).sort()).toEqual(["2B", "OF"]);
    expect(playerTokensFromLean(lean, ov).sort()).toEqual(["2B", "OF"]);

    const drafted: DraftedPlayer = {
      player_id: "123",
      name: "X",
      position: "SS",
      team: "NYY",
      team_id: "t1",
      positions: ["SS"],
    };
    expect(playerTokensFromDrafted(drafted, ov).sort()).toEqual(["2B", "OF"]);
  });

  it("6: omitted overrides preserve Mongo tokenization behavior", () => {
    const lean = mkLean(456, 20, "1B");
    const noOv = playerTokensFromLean(lean, undefined);
    const emptyMap = positionOverridesFromRequest([]);
    expect(emptyMap).toBeUndefined();
    expect(playerTokensFromLean(lean, emptyMap).sort()).toEqual(noOv.sort());
  });

  it("7: override replaces catalog position and positions[] when both exist", () => {
    const lean = mkLean(123, 40, "C");
    lean.positions = ["C", "1B", "OF"];
    const ov = positionOverridesFromRequest([...DRAFTROOM_OVERRIDE_FRAGMENT]);
    expect(playerTokensFromLean(lean, ov).sort()).toEqual(["2B", "OF"]);
  });

  it("8: pos_eligibility_threshold alone does not change auction_value", () => {
    const pool = [
      mkLean(1, 35, "OF", 1),
      mkLean(2, 12, "OF", 4),
      ...Array.from({ length: 16 }, (_, i) => mkLean(200 + i, 3, "OF", 5)),
    ];
    const base: NormalizedValuationInput = {
      schemaVersion: "1.0.0",
      roster_slots: [
        { position: "OF", count: 3 },
        { position: "SP", count: 5 },
      ],
      scoring_categories: cats5x5,
      total_budget: 260,
      num_teams: 12,
      league_scope: "Mixed",
      drafted_players: [],
      deterministic: true,
      seed: 1,
      inflation_model: "replacement_slots_v2",
    };
    const a = executeValuationWorkflow(pool, { ...base, pos_eligibility_threshold: 1 });
    const b = executeValuationWorkflow(pool, { ...base, pos_eligibility_threshold: 99 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const avA = a.response.valuations.find((v) => v.player_id === "1")!.auction_value;
    const avB = b.response.valuations.find((v) => v.player_id === "1")!.auction_value;
    expect(avA).toBe(avB);
  });

  it("9: position_overrides changes auction_value when slot eligibility changes", () => {
    const slots: RosterSlot[] = [
      { position: "MI", count: 5 },
      { position: "OF", count: 3 },
      { position: "BN", count: 8 },
    ];
    const star = mkLean(123, 38, "OF", 2);
    const fillers = Array.from({ length: 28 }, (_, i) =>
      mkLean(1000 + i, 2, "OF", 5)
    );
    const pool = [star, ...fillers];

    const baseNo = scoringAwareBaselinePlayers(
      pool,
      "5x5",
      cats5x5,
      slots,
      undefined
    );
    const ov = positionOverridesFromRequest([...DRAFTROOM_OVERRIDE_FRAGMENT]);
    const baseYes = scoringAwareBaselinePlayers(pool, "5x5", cats5x5, slots, ov);

    const infNo = calculateInflation(baseNo, [], 260, 12, slots, "Mixed", {
      ...det,
      inflationModel: "replacement_slots_v2",
      rosteredPlayersForSlots: [],
      inflationCap: 100,
      inflationFloor: 0.05,
    });
    const infYes = calculateInflation(baseYes, [], 260, 12, slots, "Mixed", {
      ...det,
      inflationModel: "replacement_slots_v2",
      rosteredPlayersForSlots: [],
      inflationCap: 100,
      inflationFloor: 0.05,
      positionOverrides: ov,
    });

    const rowNo = infNo.valuations.find((v) => v.player_id === "123")!;
    const rowYes = infYes.valuations.find((v) => v.player_id === "123")!;
    expect(rowNo.auction_value).not.toBe(rowYes.auction_value);
    expect(rowNo.baseline_value).not.toBe(rowYes.baseline_value);
  });

  it("10: baseline scarcity and replacement v2 surplus share effective tokens (single source)", () => {
    const lean = mkLean(123, 25, "OF");
    const ov = positionOverridesFromRequest([...DRAFTROOM_OVERRIDE_FRAGMENT]);
    const tokens = playerTokensFromLean(lean, ov);
    expect(tokens).toEqual(effectiveFantasyTokens(lean, ov));
    // maxSurplusOverSlots (replacement v2) uses fitsRosterSlot(slot, tokens) — same `tokens` as baseline scarcity.
    const positionalKeys = new Set(["MI", "OF"]);
    const repl = { MI: 4, OF: 3 };
    expect(maxSurplusOverSlots(25, tokens, repl, positionalKeys)).toBe(22);
    expect(fitsRosterSlot("MI", tokens)).toBe(true);
    expect(fitsRosterSlot("MI", playerTokensFromLean(lean, undefined))).toBe(false);
  });

  it("11: scarcity analysis counts secondary eligibility from override (MI)", () => {
    const p = mkLean(123, 15, "DH");
    const ov = positionOverridesFromRequest([...DRAFTROOM_OVERRIDE_FRAGMENT]);
    const no = buildPositionScarcity({
      undrafted: [p],
      allPositions: ["MI"],
      numTeams: 12,
    });
    const yes = buildPositionScarcity({
      undrafted: [p],
      allPositions: ["MI"],
      numTeams: 12,
      positionOverrides: ov,
    });
    expect(no.positions[0]?.total_remaining).toBe(0);
    expect(yes.positions[0]?.total_remaining).toBe(1);
  });
});
