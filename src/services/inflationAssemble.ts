import { ENGINE_CONTRACT_VERSION } from "../lib/engineContract";
import { getValuationModelVersion } from "../lib/valuationModelVersion";
import type {
  DraftPhaseIndicator,
  InflationBoundedBy,
  InflationModel,
  ValuationResponse,
  ValuedPlayer,
} from "../types/brain";

export const DETERMINISTIC_CALCULATED_AT = "1970-01-01T00:00:00.000Z";
export const AUCTION_VALUE_NOTE =
  "auction_value is the official player dollar valuation for external evaluation and benchmarks. It always equals adjusted_value (league-wide auction dollars from the active inflation_model). The default inflation model is replacement_slots_v2.";
export const RECOMMENDED_BID_NOTE =
  "recommended_bid is a draftroom bid suggestion (phase-aware clearing anchor with floors/caps and isotonic smoothing within hitters and pitchers). It guides bidding behavior in the draft UI; it is not the engine's canonical valuation of the player — use auction_value for that.";
export const TEAM_ADJUSTED_NOTE =
  "team_adjusted_value is marginal worth to the requesting team's roster and budget context (need, dollars per open slot vs peers, remaining-slot scarcity, replacement drop-off). It is not a league-universal player price and must not replace auction_value for cross-player evaluation or leaderboards.";

export function buildInflationResponse(params: {
  inflationModelEffective: InflationModel;
  inflationFactor: number;
  inflationIndexVsOpeningAuction?: number;
  inflationRaw: number;
  inflationBoundedBy: InflationBoundedBy;
  budgetRemaining: number;
  poolValueRemaining: number;
  playersRemaining: number;
  valuations: ValuedPlayer[];
  userTeamId: string;
  draftPhase: DraftPhaseIndicator;
  slotMeta: Partial<ValuationResponse>;
  deterministic?: boolean;
}): ValuationResponse {
  const calculatedAt = params.deterministic
    ? DETERMINISTIC_CALCULATED_AT
    : new Date().toISOString();
  return {
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    inflation_model: params.inflationModelEffective,
    inflation_factor: parseFloat(params.inflationFactor.toFixed(4)),
    ...(params.inflationIndexVsOpeningAuction != null
      ? { inflation_index_vs_opening_auction: params.inflationIndexVsOpeningAuction }
      : {}),
    inflation_raw: parseFloat(params.inflationRaw.toFixed(6)),
    inflation_bounded_by: params.inflationBoundedBy,
    total_budget_remaining: params.budgetRemaining,
    pool_value_remaining: parseFloat(params.poolValueRemaining.toFixed(2)),
    players_remaining: params.playersRemaining,
    valuations: params.valuations,
    auction_value_note: AUCTION_VALUE_NOTE,
    recommended_bid_note: RECOMMENDED_BID_NOTE,
    user_team_id_used: params.userTeamId,
    team_adjusted_value_note: TEAM_ADJUSTED_NOTE,
    phase_indicator: params.draftPhase,
    calculated_at: calculatedAt,
    valuation_model_version: getValuationModelVersion(),
    ...params.slotMeta,
  };
}
