import { DEFAULT_INFLATION_MODEL } from "../lib/valuationDefaults";
import { isSymmetricOpenLeagueContext } from "../lib/symmetricLeagueOpen";
import {
  applyRecommendedBidSoftCap,
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
import { categoryProjectionByIdFromPlayers } from "../lib/categoryProjectionById";
import { attachAuctionBaselineRanksAndTiers } from "../lib/distributionTier";
import {
  buildValuedRows,
  compareByCatalogRankAsc,
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
import { resolveAuctionCurveModel, type AuctionCurveModel } from "./auctionCurveModel";
import {
  applyAuctionCurveToV2Result,
  buildAuctionCurveLeagueState,
  type AuctionCurveDebugMeta,
} from "./auctionCurveApply";
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
  const inflationOptions: CalculateInflationOptions = {
    ...options,
    categoryProjectionById:
      options?.categoryProjectionById ??
      categoryProjectionByIdFromPlayers(allPlayers),
  };

  const timings = inflationOptions.inflationPhaseTimings;
  const mark = (key: string, start: number) => {
    if (!timings) return;
    timings[key] = (timings[key] ?? 0) + (performance.now() - start);
  };

  void leagueScope;
  const requestedModel: InflationModel =
    inflationOptions.inflationModel ?? DEFAULT_INFLATION_MODEL;

  const draftedIds = new Set(draftedPlayers.map((d) => d.player_id));
  for (const pid of inflationOptions.additionalDraftedIds ?? []) {
    draftedIds.add(pid);
  }

  const tPrep = performance.now();
  /* `allPlayers` must already be the request valuation universe (see `filterValuationUniverse`). */
  const undraftedFull = allPlayers.filter((p) => !draftedIds.has(getPlayerId(p)));

  let undraftedForRows = undraftedFull;
  if (inflationOptions.playerIdsFilter && inflationOptions.playerIdsFilter.length > 0) {
    const allow = new Set(inflationOptions.playerIdsFilter);
    undraftedForRows = undraftedFull.filter((p) => allow.has(getPlayerId(p)));
  }

  const budgetRemaining = computeBudgetRemaining({
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId: inflationOptions.budgetByTeamId,
    additionalSpent: inflationOptions.additionalSpent,
  });

  const poolValueFull = undraftedFull.reduce((sum, p) => sum + (p.value || 0), 0);

  const byValueFull = [...undraftedFull].sort((a, b) =>
    compareByValueDesc(a, b, inflationOptions)
  );
  const byCatalogRankFull = [...undraftedFull].sort((a, b) =>
    compareByCatalogRankAsc(a, b, inflationOptions)
  );
  const baselineOrderRank = new Map(
    byValueFull.map((p, i) => [getPlayerId(p), i + 1])
  );
  const catalogOrderRank = new Map(
    byCatalogRankFull.map((p, i) => [getPlayerId(p), i + 1])
  );

  const byValueRows = [...undraftedForRows].sort((a, b) =>
    compareByValueDesc(a, b, inflationOptions)
  );
  mark("inflation_prep_ms", tPrep);

  const tModel = performance.now();
  const modelSelection = selectInflationModel({
    requestedModel,
    scoped: allPlayers,
    undraftedFull,
    byValueFull,
    draftedPlayers,
    rosterSlots,
    numTeams,
    budgetRemaining,
    options: inflationOptions,
    poolValueFull,
    getPlayerId,
    minAuctionBid: MIN_AUCTION_BID,
    defaultSurplusDraftablePoolMultiplier: DEFAULT_SURPLUS_DRAFTABLE_MULTIPLIER,
    inflationPhaseTimings: timings,
  });
  mark("inflation_model_selection_ms", tModel);
  const inflationModelEffective = modelSelection.inflationModelEffective;
  const poolValueRemaining = modelSelection.poolValueRemaining;
  const rawInflationFactor = modelSelection.rawInflationFactor;
  const replacementValue = modelSelection.replacementValue;
  const v2Meta = modelSelection.v2Meta;
  const v2Result = modelSelection.v2Result;

  const tClamp = performance.now();
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
  mark("inflation_clamp_ms", tClamp);

  const leagueCap = leagueSlotCapacity(rosterSlots, numTeams);

  const auctionCurveModel: AuctionCurveModel = resolveAuctionCurveModel(
    options?.auctionCurveModel
  );
  let v2ForRows = v2Result;
  let curveDebug: AuctionCurveDebugMeta | undefined;
  if (inflationModelEffective === "replacement_slots_v2" && v2Result) {
    const remainingSlotsCurve =
      v2Meta.remaining_slots ?? Math.max(0, leagueCap - draftedPlayers.length);
    const leagueState = buildAuctionCurveLeagueState({
      leagueSlotCapacity: leagueCap,
      remainingSlots: remainingSlotsCurve,
      numTeams,
      totalBudgetPerTeam,
      budgetRemaining,
      v2: v2Result,
      rosteredForSlots: options?.rosteredPlayersForSlots ?? [],
      draftedPlayers,
      additionalDraftedIds: options?.additionalDraftedIds,
      inflationRaw,
      inflationFactor,
    });
    const applied = applyAuctionCurveToV2Result({
      requestedModel: options?.auctionCurveModel,
      v2Result,
      // Surplus tiers apply only to greedy draftable winners; others stay at min_bid.
      undraftedFringeIds: [],
      leagueState,
      inflationFactor,
    });
    v2ForRows = applied.v2ForRows;
    curveDebug = applied.debug;
  }

  const tIdx = performance.now();
  const inflationIndexVsOpeningAuction = computeInflationIndexVsOpeningAuction({
    inflationModelEffective,
    v2Result: v2ForRows,
    options,
    draftedPlayers,
    scoped: allPlayers,
    rosterSlots,
    numTeams,
    budgetRemaining,
    inflationFactor,
    getPlayerId,
    inflationPhaseTimings: timings,
  });
  mark("inflation_opening_index_ms", tIdx);

  const tRows = performance.now();
  const valuations = buildValuedRows({
    byValueRows,
    inflationModelEffective,
    v2Result: v2ForRows,
    replacementValue,
    inflationFactor,
    minAuctionBid: MIN_AUCTION_BID,
    auctionCurveModel,
    baselineOrderRank,
    catalogOrderRank,
    undraftedCount: undraftedFull.length,
  });
  mark("inflation_build_valued_rows_ms", tRows);

  const tTiers = performance.now();
  attachAuctionBaselineRanksAndTiers(valuations, options);
  mark("inflation_attach_tiers_ms", tTiers);

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
    inflationModelEffective === "replacement_slots_v2" && v2ForRows
      ? v2ForRows.replacement_values_by_slot_or_position
      : {};
  const byRowPlayerId = new Map(byValueRows.map((p) => [getPlayerId(p), p]));

  const tRec = performance.now();
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
      inflationModelEffective === "replacement_slots_v2" && v2ForRows
        ? v2ForRows.playerIdToSurplusBasis
        : undefined,
    assignedSlotByPlayerId: v2ForRows?.playerIdToAssignedSlot,
    marginalReplacementByPlayerId: v2ForRows?.playerIdToMarginalReplacement,
    curveTierByPlayerId: v2ForRows?.playerIdToSurplusTier,
    curveWeightByPlayerId: v2ForRows?.playerIdToCurveWeight,
  });

  smoothRecommendedBids(valuations, MIN_AUCTION_BID);

  const capRatio = options?.recommendedBidSoftCapRatio;
  if (capRatio != null) {
    applyRecommendedBidSoftCap(valuations, capRatio, MIN_AUCTION_BID);
  }
  mark("inflation_recommended_bid_pass_ms", tRec);

  const symmetricOpenLeague = isSymmetricOpenLeagueContext({
    numTeams,
    draftedPlayers,
    additionalDraftedIds: options?.additionalDraftedIds ?? [],
    budgetByTeamId: options?.budgetByTeamId,
    rosteredPlayersForSlots: options?.rosteredPlayersForSlots,
  });

  const userTeamId = options?.userTeamId?.trim() || DEFAULT_USER_TEAM_ID;
  const tTeam = performance.now();
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
  mark("inflation_team_adjusted_pass_ms", tTeam);

  const slotMeta: Partial<ValuationResponse> = {
    ...v2Meta,
    auction_curve_model: curveDebug?.auction_curve_model ?? auctionCurveModel,
    ...(curveDebug
      ? {
          auction_curve_reason: curveDebug.auction_curve_reason,
          curve_inputs: curveDebug.curve_inputs,
          curve_guardrails: curveDebug.curve_guardrails,
          ...(curveDebug.curve_guardrails_applied
            ? { curve_guardrails_applied: curveDebug.curve_guardrails_applied }
            : {}),
          top10_linear_spread: curveDebug.top10_linear_spread,
          selected_weights: curveDebug.selected_weights,
          ...(curveDebug.surplus_conservation_delta != null
            ? { surplus_conservation_delta: curveDebug.surplus_conservation_delta }
            : {}),
          internal_allocation_mode: curveDebug.internal_allocation_mode,
        }
      : {}),
    ...(v2Meta.remaining_slots == null
      ? { remaining_slots: Math.max(0, leagueCap - draftedPlayers.length) }
      : {}),
  };

  const tAsm = performance.now();
  const built = buildInflationResponse({
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
  mark("inflation_build_response_ms", tAsm);
  return built;
}
