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
  "recommended_bid is a suggested bid / draftroom market anchor (not league-wide FMV). It blends auction_value (a=adjusted_value) toward list baseline_value (r) via a phase/depth lambda L: initialClearingPrice = a + L*(r-a), then hitter/pitcher floors, caps, elite boosts, and isotonic smoothing. After that pass it is clamped to max_bid so the suggestion never exceeds the team hard stop.";
export const MAX_BID_NOTE =
  "max_bid is the team-specific hard stop (auction ceiling): computed after team_adjusted_value from team marginal dollars plus small bounded premiums (elite tier, slot scarcity, roster fit when asymmetric) and penalties (budget pressure, roster tightness). It is not an alias of recommended_bid; use auction_value for league-wide FMV.";
export const EDGE_NOTE =
  "edge is team_adjusted_value minus recommended_bid after the max_bid clamp on recommended_bid (marginal roster dollars versus suggested bid). Symmetric pre-draft rows set team_adjusted_value equal to adjusted_value. Rare rows without team_adjusted_value use adjusted_value for the same minuend in validation.";
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
    max_bid_note: MAX_BID_NOTE,
    edge_note: EDGE_NOTE,
    user_team_id_used: params.userTeamId,
    team_adjusted_value_note: TEAM_ADJUSTED_NOTE,
    phase_indicator: params.draftPhase,
    calculated_at: calculatedAt,
    valuation_model_version: getValuationModelVersion(),
    ...params.slotMeta,
  };
}
