import { isReserveRosterSlotForEngine } from "./rosteredPlayersForSlots";
import { getPlayerId } from "./playerId";
import {
  applyAuctionCurveToV2Result,
  buildAuctionCurveLeagueState,
} from "../services/auctionCurveApply";
import { resolveAuctionCurveModel } from "../services/auctionCurveModel";
import { clampInflation } from "../services/inflationModel";
import { computeReplacementSlotsV2 } from "../services/replacementSlotsV2";
import { leagueSlotCapacity } from "../services/teamAdjustedBudget";
import {
  buildValuedRows,
  compareByCatalogRankAsc,
  compareByValueDesc,
} from "../services/valuationRows";
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  LeanPlayer,
  RosterSlot,
} from "../types/brain";

const MIN_AUCTION_BID = 1;

/**
 * Per-player opening auction_value (curved surplus model at replayed auction-open board).
 * Used for market inflation expected spend — not the same as post-pick FMV.
 */
export function computeOpeningAuctionValueByPlayerId(params: {
  inflationModelEffective: string;
  draftedPlayers: DraftedPlayer[];
  scoped: LeanPlayer[];
  rosterSlots: RosterSlot[];
  numTeams: number;
  totalBudgetPerTeam: number;
  budgetRemaining: number;
  options?: CalculateInflationOptions;
}): Map<string, number> {
  const {
    inflationModelEffective,
    draftedPlayers,
    scoped,
    rosterSlots,
    numTeams,
    totalBudgetPerTeam,
    budgetRemaining,
    options,
  } = params;

  if (inflationModelEffective !== "replacement_slots_v2") {
    return new Map();
  }

  const rostered = options?.rosteredPlayersForSlots ?? draftedPlayers;
  const auctionAcquiredIds = new Set(
    draftedPlayers
      .filter((d) => !isReserveRosterSlotForEngine(d.roster_slot))
      .filter((d) => d.is_keeper !== true)
      .map((d) => d.player_id)
  );
  const rosteredOpen = rostered.filter((r) => !auctionAcquiredIds.has(r.player_id));
  const offBoardOpen = new Set(rosteredOpen.map((r) => r.player_id));
  for (const pid of options?.additionalDraftedIds ?? []) {
    offBoardOpen.add(pid);
  }
  const undraftedOpen = scoped.filter((p) => !offBoardOpen.has(getPlayerId(p)));

  const auctionSpend = draftedPlayers
    .filter((d) => !isReserveRosterSlotForEngine(d.roster_slot))
    .filter((d) => d.is_keeper !== true)
    .reduce((sum, d) => sum + (d.paid ?? 0), 0);
  const budgetOpen = Math.max(0, budgetRemaining + auctionSpend);

  const baselineByIdOpen = new Map<string, number>();
  for (const p of scoped) {
    baselineByIdOpen.set(getPlayerId(p), p.value || 0);
  }

  const v2Open = computeReplacementSlotsV2(
    undraftedOpen,
    rosteredOpen,
    rosterSlots,
    numTeams,
    budgetOpen,
    baselineByIdOpen,
    {
      deterministic: options?.deterministic,
      seed: options?.seed,
      positionOverrides: options?.positionOverrides,
    }
  );

  let openClamped = clampInflation(
    v2Open.inflation_factor_precap,
    options?.inflationCap,
    options?.inflationFloor
  );
  if (v2Open.skip_inflation_clamp) {
    openClamped = {
      inflation_raw: v2Open.inflation_raw,
      inflation_factor: v2Open.inflation_factor_precap,
      inflation_bounded_by: "none",
    };
  }
  const inflationFactorOpen = openClamped.inflation_factor;

  const leagueCap = leagueSlotCapacity(rosterSlots, numTeams);
  const openingDrafted = rosteredOpen.filter((p) => p.is_keeper === true);
  const leagueState = buildAuctionCurveLeagueState({
    leagueSlotCapacity: leagueCap,
    remainingSlots: v2Open.remaining_slots,
    numTeams,
    totalBudgetPerTeam,
    budgetRemaining: budgetOpen,
    v2: v2Open,
    rosteredForSlots: rosteredOpen,
    draftedPlayers: openingDrafted,
    additionalDraftedIds: options?.additionalDraftedIds,
    inflationRaw: v2Open.inflation_raw,
    inflationFactor: inflationFactorOpen,
  });

  const applied = applyAuctionCurveToV2Result({
    requestedModel: options?.auctionCurveModel,
    v2Result: v2Open,
    undraftedFringeIds: [],
    leagueState,
    inflationFactor: inflationFactorOpen,
  });

  const byValueFull = [...undraftedOpen].sort((a, b) =>
    compareByValueDesc(a, b, options)
  );
  const byCatalogRankFull = [...undraftedOpen].sort((a, b) =>
    compareByCatalogRankAsc(a, b, options)
  );
  const baselineOrderRank = new Map(
    byValueFull.map((p, i) => [getPlayerId(p), i + 1])
  );
  const catalogOrderRank = new Map(
    byCatalogRankFull.map((p, i) => [getPlayerId(p), i + 1])
  );

  const rows = buildValuedRows({
    byValueRows: undraftedOpen,
    inflationModelEffective: "replacement_slots_v2",
    v2Result: applied.v2ForRows,
    replacementValue: 0,
    inflationFactor: inflationFactorOpen,
    minAuctionBid: MIN_AUCTION_BID,
    auctionCurveModel: resolveAuctionCurveModel(options?.auctionCurveModel),
    baselineOrderRank,
    catalogOrderRank,
    undraftedCount: undraftedOpen.length,
  });

  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(row.player_id, row.auction_value);
  }
  return out;
}
