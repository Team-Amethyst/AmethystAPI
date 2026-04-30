import { playerTokensFromLean } from "../lib/fantasyRosterSlots";
import { getPlayerId } from "../lib/playerId";
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
    if (!options?.debugSignals) continue;
    const lp = byRowPlayerId.get(row.player_id);
    const tokens = lp ? playerTokensFromLean(lp) : [];
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
    userTeamId
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
    if (!lp) continue;
    if (symmetricOpenLeague) {
      row.team_adjusted_value = parseFloat(row.adjusted_value.toFixed(2));
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
    });
    row.team_adjusted_value = computeTeamAdjustedValue({ row, multipliers });
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
    const rb = row.recommended_bid ?? minAuctionBid;
    const ta = row.team_adjusted_value ?? row.adjusted_value;
    row.edge = parseFloat((ta - rb).toFixed(2));
  }
}
