import { isSymmetricOpenLeagueContext } from "../lib/symmetricLeagueOpen";
import { filterByScope } from "../lib/leagueScope";
import {
  smoothRecommendedBids,
} from "./recommendedBid";
import {
  leagueSlotCapacity,
} from "./teamAdjustedValue";
import {
  clampInflation,
  computeBudgetRemaining,
  computeInflationIndexVsOpeningAuction,
  selectInflationModel,
} from "./inflationModel";
import {
  buildLeagueSlotDemand,
} from "../lib/fantasyRosterSlots";
import { getPlayerId } from "../lib/playerId";
import {
  buildValuedRows,
  compareByAdpAsc,
  compareByValueDesc,
} from "./valuationRows";
import {
  applyRecommendedBidPass,
  applyTeamAdjustedAndEdgePass,
  resolveDraftPhase,
} from "./inflationPostProcess";
import {
  buildInflationResponse,
} from "./inflationAssemble";
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  InflationModel,
  LeanPlayer,
  LeagueScope,
  RosterSlot,
  ValuationResponse,
} from "../types/brain";

/** Minimum auction bid reserved per empty roster slot (surplus model). */
const MIN_AUCTION_BID = 1;
const DEFAULT_USER_TEAM_ID = "team_1";

/** Draftable pool size = ceil(remaining_slots × multiplier), capped by undrafted count. */
const DEFAULT_SURPLUS_DRAFTABLE_MULTIPLIER = 1.35;

export { getPlayerId } from "../lib/playerId";

/**
 * Orchestrates the valuation pipeline: pool selection → inflation model branch → row shaping →
 * recommended bid smoothing → team-adjusted economics → response assembly.
 *
 * Contract details (budget semantics, model meanings, `player_ids` subset behavior) live in
 * `docs/valuation-inflation-semantics.md` and `docs/valuation-module-map.md`.
 */
export function calculateInflation(
  allPlayers: LeanPlayer[],
  draftedPlayers: DraftedPlayer[],
  totalBudgetPerTeam: number,
  numTeams: number,
  rosterSlots: RosterSlot[],
  leagueScope: LeagueScope = "Mixed",
  options?: CalculateInflationOptions
): ValuationResponse {
  const requestedModel: InflationModel =
    options?.inflationModel ?? "global_v1";

  const draftedIds = new Set(draftedPlayers.map((d) => d.player_id));
  for (const pid of options?.additionalDraftedIds ?? []) {
    draftedIds.add(pid);
  }

  const scoped = filterByScope(allPlayers, leagueScope);
  const undraftedFull = scoped.filter((p) => !draftedIds.has(getPlayerId(p)));

  let undraftedForRows = undraftedFull;
  if (options?.playerIdsFilter && options.playerIdsFilter.length > 0) {
    const allow = new Set(options.playerIdsFilter);
    undraftedForRows = undraftedFull.filter((p) => allow.has(getPlayerId(p)));
  }

  const budgetRemaining = computeBudgetRemaining({
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId: options?.budgetByTeamId,
    additionalSpent: options?.additionalSpent,
  });

  const poolValueFull = undraftedFull.reduce((sum, p) => sum + (p.value || 0), 0);

  const byValueFull = [...undraftedFull].sort((a, b) =>
    compareByValueDesc(a, b, options)
  );
  const byAdpFull = [...undraftedFull].sort((a, b) =>
    compareByAdpAsc(a, b, options)
  );
  const valueRank = new Map(
    byValueFull.map((p, i) => [getPlayerId(p), i + 1])
  );
  const adpRank = new Map(byAdpFull.map((p, i) => [getPlayerId(p), i + 1]));

  const byValueRows = [...undraftedForRows].sort((a, b) =>
    compareByValueDesc(a, b, options)
  );

  const modelSelection = selectInflationModel({
    requestedModel,
    scoped,
    undraftedFull,
    byValueFull,
    draftedPlayers,
    rosterSlots,
    numTeams,
    budgetRemaining,
    options,
    poolValueFull,
    getPlayerId,
    minAuctionBid: MIN_AUCTION_BID,
    defaultSurplusDraftablePoolMultiplier: DEFAULT_SURPLUS_DRAFTABLE_MULTIPLIER,
  });
  const inflationModelEffective = modelSelection.inflationModelEffective;
  const poolValueRemaining = modelSelection.poolValueRemaining;
  const rawInflationFactor = modelSelection.rawInflationFactor;
  const replacementValue = modelSelection.replacementValue;
  const v2Meta = modelSelection.v2Meta;
  const v2Result = modelSelection.v2Result;

  let clamped = clampInflation(
    rawInflationFactor,
    options?.inflationCap,
    options?.inflationFloor
  );
  if (
    inflationModelEffective === "replacement_slots_v2" &&
    v2Result?.skip_inflation_clamp
  ) {
    clamped = {
      inflation_raw: v2Result.inflation_raw,
      inflation_factor: v2Result.inflation_factor_precap,
      inflation_bounded_by: "none",
    };
  }
  const inflationFactor = clamped.inflation_factor;
  const inflationRaw = clamped.inflation_raw;
  const inflationBoundedBy = clamped.inflation_bounded_by;

  const inflationIndexVsOpeningAuction = computeInflationIndexVsOpeningAuction({
    inflationModelEffective,
    v2Result,
    options,
    draftedPlayers,
    scoped,
    rosterSlots,
    numTeams,
    budgetRemaining,
    inflationFactor,
    getPlayerId,
  });

  const valuations = buildValuedRows({
    byValueRows,
    inflationModelEffective,
    v2Result,
    replacementValue,
    inflationFactor,
    minAuctionBid: MIN_AUCTION_BID,
    valueRank,
    adpRank,
    undraftedCount: undraftedFull.length,
  });

  const leagueCap = leagueSlotCapacity(rosterSlots, numTeams);
  const remainingSlotsLeague =
    v2Meta.remaining_slots ?? Math.max(0, leagueCap - draftedPlayers.length);
  const draftPhase = resolveDraftPhase({
    rosterSlots,
    numTeams,
    remainingSlotsLeague,
    draftedCount: draftedPlayers.length,
  });

  const rosterDemandMap = buildLeagueSlotDemand(rosterSlots, numTeams);
  const rosterSlotKeysForFit = new Set(rosterDemandMap.keys());
  const replForTeam: Record<string, number> =
    inflationModelEffective === "replacement_slots_v2" && v2Result
      ? v2Result.replacement_values_by_slot_or_position
      : {};
  const byRowPlayerId = new Map(byValueRows.map((p) => [getPlayerId(p), p]));

  applyRecommendedBidPass({
    valuations,
    byValueRows,
    byRowPlayerId,
    draftPhase,
    inflationIndexVsOpeningAuction,
    minAuctionBid: MIN_AUCTION_BID,
    options,
    replForTeam,
    rosterSlotKeysForFit,
    surplusBasisByPlayerId:
      inflationModelEffective === "replacement_slots_v2" && v2Result
        ? v2Result.playerIdToSurplusBasis
        : undefined,
  });

  smoothRecommendedBids(valuations, MIN_AUCTION_BID);

  const symmetricOpenLeague = isSymmetricOpenLeagueContext({
    numTeams,
    draftedPlayers,
    additionalDraftedIds: options?.additionalDraftedIds ?? [],
    budgetByTeamId: options?.budgetByTeamId,
    rosteredPlayersForSlots: options?.rosteredPlayersForSlots,
  });

  const userTeamId = options?.userTeamId?.trim() || DEFAULT_USER_TEAM_ID;
  applyTeamAdjustedAndEdgePass({
    valuations,
    byRowPlayerId,
    symmetricOpenLeague,
    rosterSlots,
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId: options?.budgetByTeamId,
    userTeamId,
    budgetRemaining,
    remainingSlotsLeague,
    replForTeam,
    rosterSlotKeysForFit,
    minAuctionBid: MIN_AUCTION_BID,
    options,
  });

  const slotMeta: Partial<ValuationResponse> = {
    ...v2Meta,
    ...(v2Meta.remaining_slots == null
      ? { remaining_slots: Math.max(0, leagueCap - draftedPlayers.length) }
      : {}),
  };

  return buildInflationResponse({
    inflationModelEffective,
    inflationFactor,
    inflationIndexVsOpeningAuction,
    inflationRaw,
    inflationBoundedBy,
    budgetRemaining,
    poolValueRemaining,
    playersRemaining: undraftedFull.length,
    valuations,
    userTeamId,
    draftPhase,
    slotMeta,
    deterministic: options?.deterministic,
  });
}
