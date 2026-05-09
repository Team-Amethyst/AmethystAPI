import { describe, expect, it } from "vitest";
import { calculateInflation } from "../src/services/inflationEngine";
import {
  effectiveFantasyTokens,
  fitsRosterSlot,
  positionOverridesFromRequest,
  playerTokensFromLean,
} from "../src/lib/fantasyRosterSlots";
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

function mkLean(
  id: number,
  value: number,
  position: string,
  tier = 2
): LeanPlayer {
  return {
    _id: `x${id}`,
    mlbId: id,
    name: `P${id}`,
    team: "NYY",
    position,
    adp: id,
    tier,
    value,
  };
}

const det = { deterministic: true, seed: 1 } as const;

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

function minimalWorkflowInput(
  over: Partial<NormalizedValuationInput> = {}
): NormalizedValuationInput {
  return {
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
    ...over,
  };
}

describe("position_overrides pipeline", () => {
  it("effectiveFantasyTokens matches playerTokensFromLean (single helper path)", () => {
    const p = mkLean(7, 12, "C");
    const ov = positionOverridesFromRequest([
      { player_id: "7", positions: ["1B", "C"] },
    ]);
    expect(effectiveFantasyTokens(p, ov)).toEqual(playerTokensFromLean(p, ov));
  });

  it("maps request entries to override ids", () => {
    const m = positionOverridesFromRequest([
      { player_id: " 660271 ", positions: ["OF", "DH"] },
    ]);
    expect(m?.get("660271")).toEqual(["OF", "DH"]);
  });

  it("playerTokensFromLean uses override positions", () => {
    const p = mkLean(42, 10, "SS");
    const ov = positionOverridesFromRequest([
      { player_id: "42", positions: ["2B", "SS"] },
    ]);
    expect(playerTokensFromLean(p, ov).sort()).toEqual(["2B", "SS"]);
  });

  it("CI: SS-only does not count until override adds 3B (secondary corner)", () => {
    const p = mkLean(66, 14, "SS");
    const withoutOv = buildPositionScarcity({
      undrafted: [p],
      allPositions: ["CI"],
      numTeams: 12,
    });
    const ov = positionOverridesFromRequest([
      { player_id: "66", positions: ["SS", "3B"] },
    ]);
    const withOv = buildPositionScarcity({
      undrafted: [p],
      allPositions: ["CI"],
      numTeams: 12,
      positionOverrides: ov,
    });
    expect(withoutOv.positions[0]?.total_remaining).toBe(0);
    expect(withOv.positions[0]?.total_remaining).toBe(1);
  });

  it("buildPositionScarcity counts CI when override adds corner eligibility", () => {
    const p = mkLean(99, 20, "SS", 2);
    const ov = positionOverridesFromRequest([
      { player_id: "99", positions: ["SS", "3B"] },
    ]);
    const { positions } = buildPositionScarcity({
      undrafted: [p],
      allPositions: ["CI"],
      numTeams: 12,
      positionOverrides: ov,
    });
    expect(positions[0]?.total_remaining).toBe(1);
  });

  it("MI scarcity counts 2B/SS from override", () => {
    const p = mkLean(77, 12, "OF");
    const ov = positionOverridesFromRequest([
      { player_id: "77", positions: ["2B", "SS"] },
    ]);
    const { positions } = buildPositionScarcity({
      undrafted: [p],
      allPositions: ["MI"],
      numTeams: 12,
      positionOverrides: ov,
    });
    expect(positions[0]?.total_remaining).toBe(1);
  });

  it("buildPositionScarcity excludes hitter from UTIL when override is pitcher-only", () => {
    const p = mkLean(100, 15, "DH", 2);
    const ov = positionOverridesFromRequest([
      { player_id: "100", positions: ["SP", "RP"] },
    ]);
    const { positions } = buildPositionScarcity({
      undrafted: [p],
      allPositions: ["UTIL"],
      numTeams: 12,
      positionOverrides: ov,
    });
    expect(positions[0]?.total_remaining).toBe(0);
  });

  it("OF catalog row gains MI fit via 2B+OF override and changes auction_value", () => {
    const slots: RosterSlot[] = [
      { position: "MI", count: 5 },
      { position: "OF", count: 3 },
      { position: "BN", count: 8 },
    ];
    const star = mkLean(880001, 38, "OF", 2);
    const fillers = Array.from({ length: 28 }, (_, i) =>
      mkLean(900000 + i, 2, "OF", 5)
    );
    const pool = [star, ...fillers];
    const baseNoOv = scoringAwareBaselinePlayers(
      pool,
      "5x5",
      cats5x5,
      slots,
      undefined
    );
    const ovMap = positionOverridesFromRequest([
      { player_id: "880001", positions: ["OF", "2B"] },
    ]);
    const baseOv = scoringAwareBaselinePlayers(
      pool,
      "5x5",
      cats5x5,
      slots,
      ovMap
    );
    const infNo = calculateInflation(baseNoOv, [], 260, 12, slots, "Mixed", {
      ...det,
      inflationModel: "replacement_slots_v2",
      rosteredPlayersForSlots: [],
      inflationCap: 100,
      inflationFloor: 0.05,
    });
    const infOv = calculateInflation(baseOv, [], 260, 12, slots, "Mixed", {
      ...det,
      inflationModel: "replacement_slots_v2",
      rosteredPlayersForSlots: [],
      inflationCap: 100,
      inflationFloor: 0.05,
      positionOverrides: ovMap,
    });
    expect(
      fitsRosterSlot("MI", playerTokensFromLean(star, undefined))
    ).toBe(false);
    expect(fitsRosterSlot("MI", playerTokensFromLean(star, ovMap))).toBe(true);
    const rowNo = infNo.valuations.find((v) => v.player_id === "880001")!;
    const rowOv = infOv.valuations.find((v) => v.player_id === "880001")!;
    expect(rowNo.baseline_value).not.toBe(rowOv.baseline_value);
    expect(rowNo.auction_value).not.toBe(rowOv.auction_value);
  });

  it("override changes auction_value vs catalog-only positions", () => {
    const slots: RosterSlot[] = [
      { position: "SP", count: 5 },
      { position: "RP", count: 3 },
      { position: "P", count: 1 },
      { position: "BN", count: 5 },
    ];
    const pitcherHeavy = Array.from({ length: 24 }, (_, i) =>
      mkLean(3000 + i, 3 + (i % 5), "SP", 4)
    );
    const hybrid = mkLean(660271, 35, "DH", 2);
    const pool = [...pitcherHeavy, hybrid];

    const baseDefault = scoringAwareBaselinePlayers(
      pool,
      "5x5",
      cats5x5,
      slots,
      undefined
    );
    const baseOverride = scoringAwareBaselinePlayers(
      pool,
      "5x5",
      cats5x5,
      slots,
      positionOverridesFromRequest([
        { player_id: "660271", positions: ["SP", "DH"] },
      ])
    );
    const rowDefault = baseDefault.find((p) => String(p.mlbId) === "660271")!;
    const rowOverride = baseOverride.find((p) => String(p.mlbId) === "660271")!;

    const infDefault = calculateInflation(
      baseDefault,
      [],
      260,
      12,
      slots,
      "Mixed",
      {
        ...det,
        inflationModel: "replacement_slots_v2",
        rosteredPlayersForSlots: [],
        inflationCap: 100,
        inflationFloor: 0.05,
      }
    );
    const infOverride = calculateInflation(
      baseOverride,
      [],
      260,
      12,
      slots,
      "Mixed",
      {
        ...det,
        inflationModel: "replacement_slots_v2",
        rosteredPlayersForSlots: [],
        inflationCap: 100,
        inflationFloor: 0.05,
        positionOverrides: positionOverridesFromRequest([
          { player_id: "660271", positions: ["SP", "DH"] },
        ]),
      }
    );

    const aucDefault =
      infDefault.valuations.find((v) => v.player_id === "660271")!.auction_value;
    const aucOverride =
      infOverride.valuations.find((v) => v.player_id === "660271")!.auction_value;

    expect(rowDefault.value).not.toBe(rowOverride.value);
    expect(aucDefault).not.toBe(aucOverride);
  });

  it("replacement v2 uses drafted row overrides for slot assignment", () => {
    const slots: RosterSlot[] = [
      { position: "MI", count: 1 },
      { position: "BN", count: 10 },
    ];
    const rostered: DraftedPlayer[] = [
      {
        player_id: "5001",
        name: "Fill",
        position: "2B",
        team: "NYY",
        team_id: "team_1",
        positions: ["2B"],
      },
    ];
    const undrafted: LeanPlayer[] = [
      mkLean(6001, 40, "SS"),
      ...Array.from({ length: 20 }, (_, i) => mkLean(7000 + i, 2, "OF", 5)),
    ];

    const base = scoringAwareBaselinePlayers(
      undrafted,
      "5x5",
      cats5x5,
      slots,
      undefined
    );

    const withoutOv = calculateInflation(
      base,
      rostered,
      260,
      12,
      slots,
      "Mixed",
      {
        ...det,
        inflationModel: "replacement_slots_v2",
        rosteredPlayersForSlots: rostered,
        inflationCap: 100,
        inflationFloor: 0.05,
      }
    );

    const rosteredDhOnly: DraftedPlayer[] = [
      {
        ...rostered[0]!,
        position: "DH",
        positions: ["DH"],
      },
    ];
    const withOv = calculateInflation(
      base,
      rosteredDhOnly,
      260,
      12,
      slots,
      "Mixed",
      {
        ...det,
        inflationModel: "replacement_slots_v2",
        rosteredPlayersForSlots: rosteredDhOnly,
        inflationCap: 100,
        inflationFloor: 0.05,
        positionOverrides: positionOverridesFromRequest([
          { player_id: "5001", positions: ["2B", "SS"] },
        ]),
      }
    );

    expect(
      withoutOv.replacement_values_by_slot_or_position?.MI ??
        (withoutOv.replacement_values_by_slot_or_position as Record<string, number>)
          ?.mi
    ).toBeDefined();
    expect(
      withOv.replacement_values_by_slot_or_position?.MI ??
        (withOv.replacement_values_by_slot_or_position as Record<string, number>)?.mi
    ).toBeDefined();
    expect(withOv.inflation_factor).toBeGreaterThan(0);
    expect(withoutOv.inflation_factor).toBeGreaterThan(0);
  });

  it("SP primary override matches catalog-only SP tokens (no surprise drift)", () => {
    const p = mkLean(333, 25, "SP");
    const ov = positionOverridesFromRequest([{ player_id: "333", positions: ["SP"] }]);
    expect(playerTokensFromLean(p, undefined).sort()).toEqual(
      playerTokensFromLean(p, ov).sort()
    );
  });

  it("pos_eligibility_threshold alone does not change auction_value (informational)", () => {
    const pool = [
      mkLean(1, 35, "OF", 1),
      mkLean(2, 12, "OF", 4),
      ...Array.from({ length: 16 }, (_, i) => mkLean(100 + i, 3, "OF", 5)),
    ];
    const low = executeValuationWorkflow(
      pool,
      minimalWorkflowInput({ pos_eligibility_threshold: 3 })
    );
    const high = executeValuationWorkflow(
      pool,
      minimalWorkflowInput({ pos_eligibility_threshold: 99 })
    );
    expect(low.ok && high.ok).toBe(true);
    if (!low.ok || !high.ok) return;
    const a = low.response.valuations.find((v) => v.player_id === "1")!.auction_value;
    const b = high.response.valuations.find((v) => v.player_id === "1")!.auction_value;
    expect(a).toBe(b);
  });
});
