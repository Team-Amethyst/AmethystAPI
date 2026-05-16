import { playerTokensFromLean } from "../lib/fantasyRosterSlots";
import { classifyDurabilityExpectation } from "../lib/durabilityExpectation";
import type { DurabilityExpectationReason } from "../types/durabilityExpectation";
import { getPlayerId } from "../lib/playerId";
import { pickBaselineRiskExplainFromMeta } from "../types/baselineRiskExplain";
import type {
  CalculateInflationOptions,
  DraftPhaseIndicator,
  DraftedPlayer,
  LeanPlayer,
  RosterSlot,
  ValuedPlayer,
} from "../types/brain";
import {
  bestReplacementForPlayer,
  budgetPressureMultiplier,
  buildOpenSlotsForUserTeam,
  computeTeamAdjustedValue,
  dollarsPerSlotPeerRatio,
  leagueSlotCapacity,
  teamAdjustedMultipliers,
  userBudgetRemaining,
  userTeamStartingSlots,
} from "./teamAdjustedValue";
import { computeMaxBidDollars } from "./maxBid";
import {
  baseLambdaClearingPrice,
  computeRecommendedBid,
} from "./recommendedBid";

export function resolveDraftPhase(params: {
  rosterSlots: RosterSlot[];
  numTeams: number;
  remainingSlotsLeague: number;
  draftedCount: number;
}): DraftPhaseIndicator {
  const cap = leagueSlotCapacity(params.rosterSlots, params.numTeams);
  let fill = 0;
  if (cap > 0 && Number.isFinite(params.remainingSlotsLeague)) {
    fill = (cap - params.remainingSlotsLeague) / cap;
  } else if (cap > 0) {
    fill = Math.min(1, params.draftedCount / cap);
  }
  fill = Math.max(0, Math.min(1, fill));
  if (fill < 0.33) return "early";
  if (fill < 0.67) return "mid";
  return "late";
}

export function applyRecommendedBidPass(params: {
  valuations: ValuedPlayer[];
  byValueRows: LeanPlayer[];
  byRowPlayerId: Map<string, LeanPlayer>;
  draftPhase: DraftPhaseIndicator;
  inflationIndexVsOpeningAuction: number | undefined;
  minAuctionBid: number;
  options?: CalculateInflationOptions;
  replForTeam: Record<string, number>;
  rosterSlotKeysForFit: Set<string>;
  surplusBasisByPlayerId?: Map<string, number>;
}): void {
  const {
    valuations,
    byValueRows,
    byRowPlayerId,
    draftPhase,
    inflationIndexVsOpeningAuction,
    minAuctionBid,
    options,
    replForTeam,
    rosterSlotKeysForFit,
    surplusBasisByPlayerId,
  } = params;
  const baselineOrderForDepth = [...byValueRows].sort(
    (a, b) => (b.value || 0) - (a.value || 0)
  );
  const depthFracById = new Map<string, number>();
  const depthN = baselineOrderForDepth.length;
  baselineOrderForDepth.forEach((p, i) => {
    depthFracById.set(getPlayerId(p), depthN > 1 ? i / (depthN - 1) : 0);
  });

  for (const row of valuations) {
    const depthFrac = depthFracById.get(row.player_id) ?? 0.5;
    const clearing = computeRecommendedBid({
      row,
      draftPhase,
      depthFrac,
      inflationIndexVsOpeningAuction,
      minAuctionBid,
    });
    row.recommended_bid = parseFloat(clearing.toFixed(2));
    if (options?.explainValuationRows) {
      const lpEx = byRowPlayerId.get(row.player_id);
      const tokens = lpEx
        ? playerTokensFromLean(lpEx, options?.positionOverrides)
        : [];
      const replBestEx = bestReplacementForPlayer(
        tokens,
        replForTeam,
        rosterSlotKeysForFit
      );
      const sbEx = surplusBasisByPlayerId?.get(row.player_id);
      const meta = (
        lpEx?.projection as { __valuation_meta__?: Record<string, unknown> } | undefined
      )?.__valuation_meta__;
      const tw =
        meta?.two_way_role_selected === "hitter" || meta?.two_way_role_selected === "pitcher"
          ? (meta.two_way_role_selected as "hitter" | "pitcher")
          : undefined;
      const dur = lpEx
        ? classifyDurabilityExpectation(lpEx, {
            positionOverrides: options?.positionOverrides,
            twoWayRoleSelected: tw,
          })
        : {
            durability_expectation: "unknown" as const,
            durability_expectation_reasons: [] as DurabilityExpectationReason[],
          };
      row.valuation_explain = {
        effective_positions: [...tokens],
        replacement_key_used: replBestEx?.key ?? null,
        replacement_value_used:
          replBestEx?.value != null
            ? Number(replBestEx.value.toFixed(4))
            : null,
        surplus_basis:
          sbEx != null && Number.isFinite(sbEx)
            ? Number(sbEx.toFixed(4))
            : undefined,
        inflation_factor: row.inflation_factor,
        ...(meta ? pickBaselineRiskExplainFromMeta(meta) : {}),
        ...(meta?.two_way_role_selected === "hitter" ||
        meta?.two_way_role_selected === "pitcher"
          ? {
              two_way_role_selected: meta.two_way_role_selected,
              hitter_baseline_candidate: Number(meta.hitter_baseline_candidate),
              pitcher_baseline_candidate: Number(meta.pitcher_baseline_candidate),
            }
          : {}),
        durability_expectation: dur.durability_expectation,
        durability_expectation_reasons: dur.durability_expectation_reasons,
      };
    }
    if (!options?.debugSignals) continue;
    const lp = byRowPlayerId.get(row.player_id);
    const tokens = lp ? playerTokensFromLean(lp, options?.positionOverrides) : [];
    const replBest = bestReplacementForPlayer(
      tokens,
      replForTeam,
      rosterSlotKeysForFit
    );
    const sb = surplusBasisByPlayerId?.get(row.player_id);
    row.debug_v2 = {
      ...(row.debug_v2 ?? {}),
      lambda_used: Number(baseLambdaClearingPrice(draftPhase, depthFrac).toFixed(4)),
      surplus_basis:
        sb != null && Number.isFinite(sb) ? Number(sb.toFixed(4)) : undefined,
      replacement_key_used: replBest?.key ?? null,
      replacement_value_used:
        replBest?.value != null ? Number(replBest.value.toFixed(4)) : null,
    };
  }
}

export function applyTeamAdjustedAndEdgePass(params: {
  valuations: ValuedPlayer[];
  byRowPlayerId: Map<string, LeanPlayer>;
  symmetricOpenLeague: boolean;
  rosterSlots: RosterSlot[];
  draftedPlayers: DraftedPlayer[];
  totalBudgetPerTeam: number;
  numTeams: number;
  budgetByTeamId: Record<string, number> | undefined;
  userTeamId: string;
  budgetRemaining: number;
  remainingSlotsLeague: number;
  replForTeam: Record<string, number>;
  rosterSlotKeysForFit: Set<string>;
  minAuctionBid: number;
  options?: CalculateInflationOptions;
}): void {
  const {
    valuations,
    byRowPlayerId,
    symmetricOpenLeague,
    rosterSlots,
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId,
    userTeamId,
    budgetRemaining,
    remainingSlotsLeague,
    replForTeam,
    rosterSlotKeysForFit,
    minAuctionBid,
    options,
  } = params;
  const openSlots = buildOpenSlotsForUserTeam(
    rosterSlots,
    options?.rosteredPlayersForSlots,
    userTeamId,
    options?.positionOverrides
  );
  const budgetMult = budgetPressureMultiplier(
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId,
    userTeamId,
    budgetRemaining
  );
  const userRemaining = userBudgetRemaining(
    draftedPlayers,
    totalBudgetPerTeam,
    budgetByTeamId,
    userTeamId
  );
  const openSeatTotal = [...openSlots.values()].reduce((s, v) => s + v, 0);
  const userCap = userTeamStartingSlots(rosterSlots);
  const slotFillRatio =
    userCap > 0 ? Math.max(0, Math.min(1, openSeatTotal / userCap)) : 1;
  /** Open-seat share of starting lineup (1 = all seats open) — roster flexibility input for max_bid. */
  const openSeatFraction = userCap > 0 ? openSeatTotal / userCap : 1;
  const slotScarcityMult = 1 + 0.22 * (1 - slotFillRatio);
  const dpsRatio = dollarsPerSlotPeerRatio({
    userRemaining,
    openSeatTotal,
    budgetRemainingLeague: budgetRemaining,
    numTeams,
    remainingSlotsLeague: Math.max(1, remainingSlotsLeague),
  });
  let dpsMult = 1;
  if (dpsRatio > 1.18) {
    dpsMult += 0.14 * Math.min(2.2, dpsRatio - 1.18);
  } else if (dpsRatio < 0.82) {
    dpsMult -= 0.11 * Math.min(1.2, 0.82 - dpsRatio);
  }

  for (const row of valuations) {
    const lp = byRowPlayerId.get(row.player_id);
    const neutralMaxMult = {
      need: 1,
      budget: budgetMult,
      dollars_per_slot: dpsMult,
      slot_scarcity: slotScarcityMult,
      replacement_dropoff: 1,
    } as const;

    if (!lp) {
      row.max_bid = computeMaxBidDollars({
        row,
        base: row.adjusted_value,
        adjustedValue: row.adjusted_value,
        minAuctionBid,
        multipliers: neutralMaxMult,
        symmetricOpen: symmetricOpenLeague,
        openSeatFraction,
      });
      continue;
    }

    if (symmetricOpenLeague) {
      row.team_adjusted_value = parseFloat(row.adjusted_value.toFixed(2));
      row.max_bid = computeMaxBidDollars({
        row,
        base: row.team_adjusted_value,
        adjustedValue: row.adjusted_value,
        minAuctionBid,
        multipliers: neutralMaxMult,
        symmetricOpen: true,
        openSeatFraction,
      });
      if (options?.debugSignals) {
        row.debug_v2 = {
          ...(row.debug_v2 ?? {}),
          team_multipliers: { symmetric_open_collapsed: 1 },
        };
      }
      continue;
    }

    const multipliers = teamAdjustedMultipliers({
      row,
      lp,
      openSlots,
      budgetMult,
      dpsMult,
      slotScarcityMult,
      replForTeam,
      rosterSlotKeysForFit,
      positionOverrides: options?.positionOverrides,
    });
    row.team_adjusted_value = computeTeamAdjustedValue({ row, multipliers });
    row.max_bid = computeMaxBidDollars({
      row,
      base: row.team_adjusted_value,
      adjustedValue: row.adjusted_value,
      minAuctionBid,
      multipliers,
      symmetricOpen: false,
      openSeatFraction,
    });
    if (options?.debugSignals) {
      row.debug_v2 = {
        ...(row.debug_v2 ?? {}),
        team_multipliers: {
          need: Number(multipliers.need.toFixed(4)),
          budget: Number(multipliers.budget.toFixed(4)),
          dollars_per_slot: Number(multipliers.dollars_per_slot.toFixed(4)),
          slot_scarcity: Number(multipliers.slot_scarcity.toFixed(4)),
          replacement_dropoff: Number(multipliers.replacement_dropoff.toFixed(4)),
        },
      };
    }
  }

  for (const row of valuations) {
    if (row.max_bid != null && row.recommended_bid != null) {
      const capped = Math.min(row.recommended_bid, row.max_bid);
      row.recommended_bid = parseFloat(Math.max(minAuctionBid, capped).toFixed(2));
    }
  }

  for (const row of valuations) {
    const rb = row.recommended_bid ?? minAuctionBid;
    const ta = row.team_adjusted_value ?? row.adjusted_value;
    row.edge = parseFloat((ta - rb).toFixed(2));
  }
}
