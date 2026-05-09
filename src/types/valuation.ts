import type {
  DraftPhaseIndicator,
  DraftedPlayer,
  InflationBoundedBy,
  InflationModel,
  LeagueScope,
  RosterSlot,
  ScoringCategory,
  ScoringFormat,
  TeamRosterBucket,
  ValueIndicator,
} from "./core";

/** Per-player catalog position overrides (Draftroom eligibility); replaces Mongo `position` / `positions` for valuation math. */
export type PositionOverrideEntry = { player_id: string; positions: string[] };

export interface ValuationRequest {
  roster_slots: RosterSlot[];
  scoring_categories: ScoringCategory[];
  total_budget: number;
  num_teams?: number;
  drafted_players: DraftedPlayer[];
  league_scope?: LeagueScope;
  schemaVersion?: string;
  schema_version?: string;
  checkpoint?: string;
  deterministic?: boolean;
  seed?: number;
  player_ids?: string[];
  eligible_player_ids?: string[];
  excluded_player_ids?: string[];
  inflation_model?: InflationModel;
  budget_by_team_id?: Record<string, number>;
  user_team_id?: string;
  scoring_format?: ScoringFormat;
  hitter_budget_pct?: number;
  /** Reserved / informational — does not apply min-games eligibility from catalog (no games-by-position in Mongo). Use `position_overrides` for explicit eligibility. */
  pos_eligibility_threshold?: number;
  position_overrides?: PositionOverrideEntry[];
  strict_scoring_categories?: boolean;
  minors?: TeamRosterBucket[];
  taxi?: TeamRosterBucket[];
}

export interface ValuationLeagueBlock {
  roster_slots: RosterSlot[];
  scoring_categories: ScoringCategory[];
  total_budget: number;
  num_teams?: number;
  league_scope?: LeagueScope;
  scoring_format?: ScoringFormat;
  hitter_budget_pct?: number;
  /** Reserved / informational — does not apply min-games eligibility from catalog. Use `position_overrides` for explicit eligibility. */
  pos_eligibility_threshold?: number;
  position_overrides?: PositionOverrideEntry[];
  strict_scoring_categories?: boolean;
  inflation_model?: InflationModel;
}

export interface NormalizedValuationInput {
  schemaVersion: string;
  league_id?: string;
  checkpoint?: string;
  roster_slots: RosterSlot[];
  scoring_categories: ScoringCategory[];
  total_budget: number;
  num_teams: number;
  league_scope: LeagueScope;
  drafted_players: DraftedPlayer[];
  scoring_format?: ScoringFormat;
  hitter_budget_pct?: number;
  /** Reserved / informational — v1 does not apply min-games rules from Mongo. Use `position_overrides`. */
  pos_eligibility_threshold?: number;
  position_overrides?: PositionOverrideEntry[];
  /**
   * When true, valuation fails closed if `scoring_categories` includes any name
   * not wired in v1 baselines (see `scoringCategorySupport.ts`). Default false:
   * unsupported names emit `scoring_category_warnings` on the response instead.
   */
  strict_scoring_categories?: boolean;
  pre_draft_rosters?: Record<string, unknown[]>;
  minors?: TeamRosterBucket[] | Record<string, unknown[]>;
  taxi?: TeamRosterBucket[] | Record<string, unknown[]>;
  deterministic: boolean;
  seed?: number;
  player_ids?: string[];
  /** If set and non-empty, only these player ids are in the valuation universe. */
  eligible_player_ids?: string[];
  /** Removed from the valuation universe (after scope + eligible). */
  excluded_player_ids?: string[];
  budget_by_team_id?: Record<string, number>;
  user_team_id?: string;
  inflation_model?: InflationModel;
}

export interface CalculateInflationOptions {
  deterministic?: boolean;
  seed?: number;
  playerIdsFilter?: string[];
  budgetByTeamId?: Record<string, number>;
  additionalSpent?: number;
  additionalDraftedIds?: string[];
  inflationCap?: number;
  inflationFloor?: number;
  inflationModel?: InflationModel;
  remainingLeagueSlots?: number;
  surplusDraftablePoolMultiplier?: number;
  rosteredPlayersForSlots?: DraftedPlayer[];
  userTeamId?: string;
  debugSignals?: boolean;
  /** From request `position_overrides`; replaces Mongo positions for slot/token logic across baseline, replacement v2, team-adjusted, scarcity. */
  positionOverrides?: Map<string, string[]>;
}

export interface ValuedPlayer {
  player_id: string;
  name: string;
  position: string;
  team: string;
  adp: number;
  tier: number;
  baseline_value: number;
  /** Official dollar valuation for benchmarks and external evaluation; equals `adjusted_value`. */
  auction_value: number;
  adjusted_value: number;
  /** Draftroom bid suggestion (phase/depth/smoothing); not the canonical player valuation — use `auction_value`. */
  recommended_bid?: number;
  /** Marginal worth to the requesting team's roster/budget context only; not a league-universal price — use `auction_value` for that. */
  team_adjusted_value?: number;
  edge?: number;
  indicator: ValueIndicator;
  inflation_factor: number;
  baseline_components?: {
    scoring_format: ScoringFormat | "default";
    projection_component: number;
    scarcity_component: number;
    age_depth_component?: number;
    injury_component?: number;
  };
  scarcity_adjustment?: number;
  inflation_adjustment?: number;
  why?: string[];
  explain_v2?: {
    indicator: ValueIndicator;
    auction_target: number;
    list_value: number;
    adjustments: {
      scarcity: number;
      inflation: number;
      other: number;
    };
    drivers: {
      label: string;
      impact: number;
      reason: string;
    }[];
    confidence: number;
  };
  debug_v2?: {
    surplus_basis?: number;
    replacement_key_used?: string | null;
    replacement_value_used?: number | null;
    lambda_used?: number;
    team_multipliers?:
      | {
          need: number;
          budget: number;
          dollars_per_slot: number;
          slot_scarcity: number;
          replacement_dropoff: number;
        }
      | { symmetric_open_collapsed: 1 };
  };
}

export interface ValuationResponse {
  engine_contract_version: string;
  inflation_model: InflationModel;
  inflation_factor: number;
  inflation_index_vs_opening_auction?: number;
  inflation_percent_vs_auction_open?: number;
  inflation_raw: number;
  inflation_bounded_by: InflationBoundedBy;
  total_budget_remaining: number;
  pool_value_remaining: number;
  players_remaining: number;
  valuations: ValuedPlayer[];
  calculated_at: string;
  valuation_model_version?: string;
  market_notes?: string[];
  /** Present when the request included scoring category names not implemented in v1 baselines. */
  scoring_category_warnings?: string[];
  remaining_slots?: number;
  min_bid?: number;
  surplus_cash?: number;
  total_surplus_mass?: number;
  draftable_pool_size?: number;
  replacement_values_by_slot_or_position?: Record<string, number>;
  fallback_reason?: string | null;
  /** Explains `auction_value` as the canonical official valuation (mirrors `adjusted_value`). */
  auction_value_note?: string;
  recommended_bid_note?: string;
  user_team_id_used?: string;
  team_adjusted_value_note?: string;
  phase_indicator?: DraftPhaseIndicator;
  context_v2?: {
    schema_version: "2";
    calculated_at: string;
    scope: {
      league_id: string;
      player_id?: string;
      position?: string;
    };
    market_summary: {
      headline: string;
      inflation_factor: number;
      inflation_raw: number;
      inflation_bounded_by: InflationBoundedBy;
      inflation_percent_vs_neutral: number;
      inflation_percent_vs_auction_open?: number;
      inflation_index_vs_opening_auction?: number;
      budget_left: number;
      players_left: number;
      model_version: string;
    };
    position_alerts: {
      position: string;
      severity: "low" | "medium" | "high" | "critical";
      urgency_score: number;
      message: string;
      evidence: {
        elite_remaining: number;
        mid_tier_remaining: number;
        total_remaining: number;
      };
      recommended_action: string;
    }[];
    assumptions: string[];
    confidence: {
      overall: number;
      notes?: string;
    };
  };
}
