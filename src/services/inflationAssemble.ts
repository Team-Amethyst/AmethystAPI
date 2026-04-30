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
export const RECOMMENDED_BID_NOTE =
  "recommended_bid is a phase-aware model clearing target (star floors, pitcher dampening, isotonic smoothing)—a bidding guide, not a prediction of the winning hammer price; room behavior can diverge materially.";
export const TEAM_ADJUSTED_NOTE =
  "team_adjusted_value scales adjusted_value by roster need, dollars per open slot vs league peers, remaining-slot scarcity, and replacement drop-off for eligible slots; when the league snapshot is symmetric (no auction picks, no keeper/minors/taxi off-board ids, equal per-team budgets in budget_by_team_id when provided, equal rostered counts per team), it equals adjusted_value";

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
    recommended_bid_note: RECOMMENDED_BID_NOTE,
    user_team_id_used: params.userTeamId,
    team_adjusted_value_note: TEAM_ADJUSTED_NOTE,
    phase_indicator: params.draftPhase,
    calculated_at: calculatedAt,
    valuation_model_version: getValuationModelVersion(),
    ...params.slotMeta,
  };
}
