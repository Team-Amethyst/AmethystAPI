import { ENGINE_CONTRACT_VERSION } from "../lib/engineContract";
import { getValuationModelVersion } from "../lib/valuationModelVersion";
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
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  InflationModel,
  LeanPlayer,
  LeagueScope,
  RosterSlot,
  ValuationResponse,
} from "../types/brain";

const DETERMINISTIC_CALCULATED_AT = "1970-01-01T00:00:00.000Z";

/** Minimum auction bid reserved per empty roster slot (surplus model). */
const MIN_AUCTION_BID = 1;
const RECOMMENDED_BID_NOTE =
  "recommended_bid is a phase-aware model clearing target (star floors, pitcher dampening, isotonic smoothing)—a bidding guide, not a prediction of the winning hammer price; room behavior can diverge materially.";
const TEAM_ADJUSTED_NOTE =
  "team_adjusted_value scales adjusted_value by roster need, dollars per open slot vs league peers, remaining-slot scarcity, and replacement drop-off for eligible slots; when the league snapshot is symmetric (no auction picks, no keeper/minors/taxi off-board ids, equal per-team budgets in budget_by_team_id when provided, equal rostered counts per team), it equals adjusted_value";
const DEFAULT_USER_TEAM_ID = "team_1";

/** Draftable pool size = ceil(remaining_slots × multiplier), capped by undrafted count. */
const DEFAULT_SURPLUS_DRAFTABLE_MULTIPLIER = 1.35;

export { getPlayerId } from "../lib/playerId";

/**
 * Calculates auction inflation and returns adjusted player valuations.
 *
 * **Budget (contract):**
 * - If `options.budgetByTeamId` is non-empty: `total_budget_remaining` = **sum of map values**
 *   (per-team **remaining** dollars). **`paid` on `drafted_players` is ignored** for that request.
 * - Otherwise: `total_budget_remaining` = `total_budget * num_teams` − **sum(`drafted_players[].paid`)**
 *   (missing `paid` treated as 0). **`pre_draft_rosters`, `minors`, and `taxi` do not affect spend in v1.**
 *
 * **`inflation_model`:**
 * - `global_v1` — `inflation_factor` ≈ remaining budget ÷ sum of baseline $ on the **full** undrafted pool;
 *   `adjusted_value` = `baseline_value × inflation_factor`.
 * - `surplus_slots_v1` — reserves `MIN_AUCTION_BID` per remaining empty roster slot, builds a
 *   top-by-baseline draftable slice sized from those slots, sets replacement at the slice floor,
 *   then `inflation_raw = surplus_cash / Σ max(0, baseline − replacement)` on that slice and
 *   `adjusted_value = MIN_AUCTION_BID + inflation_factor × max(0, baseline − replacement)` for
 *   every undrafted row. Falls back to `global_v1` math when the surplus plan is degenerate.
 * - `replacement_slots_v2` — slot/position-aware replacement levels + surplus allocation
 *   (preferred for Draftroom). Never falls back to `global_v1`; see response metadata.
 *
 * **`player_ids`:** does not change the inflation denominator; it only filters
 * which rows appear in `valuations[]` (same parameters applied to each).
 *
 * Value Indicator:
 *   Ranks use the **full** undrafted pool so Steal/Reach stay meaningful when
 *   `valuations[]` is a subset.
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

  const calculatedAt = options?.deterministic
    ? DETERMINISTIC_CALCULATED_AT
    : new Date().toISOString();

  return {
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    inflation_model: inflationModelEffective,
    inflation_factor: parseFloat(inflationFactor.toFixed(4)),
    ...(inflationIndexVsOpeningAuction != null
      ? { inflation_index_vs_opening_auction: inflationIndexVsOpeningAuction }
      : {}),
    inflation_raw: parseFloat(inflationRaw.toFixed(6)),
    inflation_bounded_by: inflationBoundedBy,
    total_budget_remaining: budgetRemaining,
    pool_value_remaining: parseFloat(poolValueRemaining.toFixed(2)),
    players_remaining: undraftedFull.length,
    valuations,
    recommended_bid_note: RECOMMENDED_BID_NOTE,
    user_team_id_used: userTeamId,
    team_adjusted_value_note: TEAM_ADJUSTED_NOTE,
    phase_indicator: draftPhase,
    calculated_at: calculatedAt,
    valuation_model_version: getValuationModelVersion(),
    ...slotMeta,
  };
}
