// ─── League Configuration ────────────────────────────────────────────────────

export type LeagueScope = "Mixed" | "AL" | "NL";

export interface RosterSlot {
  /** e.g. "C", "1B", "2B", "3B", "SS", "OF", "SP", "RP", "UTIL", "BN" */
  position: string;
  count: number;
}

export interface ScoringCategory {
  /** e.g. "HR", "RBI", "AVG", "SB", "R", "W", "ERA", "WHIP", "K", "SV" */
  name: string;
  type: "batting" | "pitching";
}

// ─── Draft State ─────────────────────────────────────────────────────────────

/**
 * Drafted or rostered player in engine requests.
 * `player_id` is the string form of the MLB person id (same as Mongo `mlbId`), e.g. "660271".
 */
export interface DraftedPlayer {
  player_id: string;
  name: string;
  /** Primary slot / display position; keep for backward compatibility. */
  position: string;
  /** Full fantasy eligibility when known (engine may use for future scarcity / slot logic). */
  positions?: string[];
  /** MLB team abbreviation, e.g. "NYY", "BOS" */
  team: string;
  /** Fantasy team identifier */
  team_id: string;
  /** Auction price paid */
  paid?: number;
  adp?: number;
  is_keeper?: boolean;
  keeper_cost?: number;
  pick_number?: number;
  roster_slot?: string;
}

export interface MockPickTeam {
  team_id: string;
  roster: DraftedPlayer[];
  budget_remaining?: number;
}

/** Minors / taxi buckets from Draft fixtures (`{ team_id, players[] }[]`). */
export interface TeamRosterBucket {
  team_id: string;
  players: DraftedPlayer[];
}

export type ScoringFormat = "5x5" | "6x6" | "points";

// ─── Shared player shape returned from MongoDB lean queries ──────────────────

export interface LeanPlayer {
  _id: unknown;
  /** Numeric MLB player ID — used as the canonical player_id in all Engine requests */
  mlbId?: number;
  name: string;
  team: string;
  position: string;
  adp: number;
  tier: number;
  value: number;
  outlook?: string;
  stats?: Record<string, unknown>;
  projection?: Record<string, unknown>;
}

// ─── Valuation ───────────────────────────────────────────────────────────────

/** Legacy flat POST body (schemaVersion implicit 0.0.0). */
/** Inflation pass: league-wide list rescale vs roster-constrained surplus dollars. */
export type InflationModel =
  | "global_v1"
  | "surplus_slots_v1"
  | "replacement_slots_v2";

export interface ValuationRequest {
  roster_slots: RosterSlot[];
  scoring_categories: ScoringCategory[];
  /** Per-team auction budget */
  total_budget: number;
  /** Number of teams in the league (default: 12) */
  num_teams?: number;
  /** All drafted players across every fantasy team */
  drafted_players: DraftedPlayer[];
  league_scope?: LeagueScope;
  /** Same as `schema_version`; Draft may send either. */
  schemaVersion?: string;
  /** Draft / fixture schema version (e.g. 1.0.0). */
  schema_version?: string;
  checkpoint?: string;
  deterministic?: boolean;
  /** With `deterministic`, influences tie-break ordering so CI can pin outputs. */
  seed?: number;
  /** Restrict valuation rows to these undrafted player ids (subset evaluation). */
  player_ids?: string[];
  /**
   * `global_v1` — multiply every baseline by one factor (budget ÷ full undrafted pool $).
   * `surplus_slots_v1` — reserve $1 per remaining roster slot, inflate only value above
   * replacement within a top draftable slice sized from remaining slots (see docs).
   * `replacement_slots_v2` — position/slot-aware replacement + surplus allocation (preferred for Draftroom).
   */
  inflation_model?: InflationModel;
  /** When set, total remaining league budget = sum of values (ignores sum of paid). */
  budget_by_team_id?: Record<string, number>;
  /** Team context for team_adjusted_value (defaults to team_1 when omitted). */
  user_team_id?: string;
  scoring_format?: ScoringFormat;
  hitter_budget_pct?: number;
  pos_eligibility_threshold?: number;
  minors?: TeamRosterBucket[];
  taxi?: TeamRosterBucket[];
}

/** Nested league block for versioned valuation requests (schema 1.x). */
export interface ValuationLeagueBlock {
  roster_slots: RosterSlot[];
  scoring_categories: ScoringCategory[];
  total_budget: number;
  num_teams?: number;
  league_scope?: LeagueScope;
  scoring_format?: ScoringFormat;
  hitter_budget_pct?: number;
  pos_eligibility_threshold?: number;
  inflation_model?: InflationModel;
}

/**
 * Normalized input after Zod parse — used by the inflation engine and tests.
 * Optional sections are accepted and validated for forward compatibility; v1 math may ignore them.
 */
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
  pos_eligibility_threshold?: number;
  pre_draft_rosters?: Record<string, unknown[]>;
  /** Draft upstream uses `{ team_id, players[] }[]`; nested legacy fixtures may use a record map. */
  minors?: TeamRosterBucket[] | Record<string, unknown[]>;
  taxi?: TeamRosterBucket[] | Record<string, unknown[]>;
  deterministic: boolean;
  seed?: number;
  player_ids?: string[];
  budget_by_team_id?: Record<string, number>;
  user_team_id?: string;
  /** Defaults to `global_v1` when omitted (`executeValuationWorkflow` normalizes). */
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
  /** Required for `surplus_slots_v1` (league empty slots from roster − filled ids). */
  remainingLeagueSlots?: number;
  /**
   * Draftable slice = `ceil(remainingLeagueSlots × multiplier)` capped by undrafted count.
   * @default 1.35
   */
  surplusDraftablePoolMultiplier?: number;
  /** Rostered players (auction + keepers + minors/taxi) for slot demand in `replacement_slots_v2`. */
  rosteredPlayersForSlots?: DraftedPlayer[];
  /** Team context for team_adjusted_value (defaults to team_1 when omitted). */
  userTeamId?: string;
}

export type ValueIndicator = "Steal" | "Reach" | "Fair Value";

export interface ValuedPlayer {
  player_id: string;
  name: string;
  position: string;
  team: string;
  adp: number;
  tier: number;
  baseline_value: number;
  adjusted_value: number;
  /**
   * Presentation-layer bid guidance: blends marginal auction value (`adjusted_value`)
   * with baseline list strength (`baseline_value`) without changing valuation math.
   */
  recommended_bid?: number;
  /** Team-specific bid signal for Draftroom decisions (additive presentation layer). */
  team_adjusted_value?: number;
  indicator: ValueIndicator;
  inflation_factor: number;
  baseline_components?: {
    scoring_format: ScoringFormat | "default";
    projection_component: number;
    scarcity_component: number;
  };
  /**
   * Always `0` in current responses: roster/scarcity is already in `baseline_value`
   * (`baseline_components.scarcity_component`). Kept for wire compatibility.
   */
  scarcity_adjustment?: number;
  /** `adjusted_value - baseline_value` (full delta from the league-wide inflation factor). */
  inflation_adjustment?: number;
  /** Human-readable rationale (additive contract field). */
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
}

export type InflationBoundedBy = "none" | "cap" | "floor";

export interface ValuationResponse {
  /** Engine HTTP/JSON contract major version (debug drift vs Draft). */
  engine_contract_version: string;
  /** Which inflation pass produced this response (echo of request defaulting rule). */
  inflation_model: InflationModel;
  /** > 1.0 = inflated market; < 1.0 = deflated */
  inflation_factor: number;
  /**
   * Pre–cap/floor ratio. Meaning depends on `inflation_model`:
   * - `global_v1`: `total_budget_remaining / pool_value_remaining` (full undrafted baseline $).
   * - `surplus_slots_v1`: `surplus_cash / sum(surplus baseline $ in draftable pool)` where
   *   `surplus_cash = total_budget_remaining − remaining_slots×min_bid` and `pool_value_remaining`
   *   matches the surplus denominator (not full-wire list $).
   * - `replacement_slots_v2`: `surplus_cash / total_surplus_mass` over the slot-assigned draftable pool;
   *   see response metadata fields.
   */
  inflation_raw: number;
  /** Whether `inflation_factor` was raised to floor, lowered to cap, or left as raw. */
  inflation_bounded_by: InflationBoundedBy;
  total_budget_remaining: number;
  pool_value_remaining: number;
  players_remaining: number;
  valuations: ValuedPlayer[];
  calculated_at: string;
  /** Build label: `VALUATION_MODEL_VERSION`, git SHA at deploy, or `package.json` name@version. */
  valuation_model_version?: string;
  /** League-wide human notes (inflation, scarcity alerts, monopolies). */
  market_notes?: string[];
  /** Set when `inflation_model` is `replacement_slots_v2` (transparent economics / QA). */
  remaining_slots?: number;
  min_bid?: number;
  surplus_cash?: number;
  total_surplus_mass?: number;
  draftable_pool_size?: number;
  replacement_values_by_slot_or_position?: Record<string, number>;
  /** Why v2 used a non-standard price path (never falls back to `global_v1`). */
  fallback_reason?: string | null;
  /** Product copy for `recommended_bid` semantics (presentation layer guidance). */
  recommended_bid_note?: string;
  /** Team context used to compute team_adjusted_value (defaults to team_1). */
  user_team_id_used?: string;
  /** Product copy for `team_adjusted_value` semantics (presentation layer guidance). */
  team_adjusted_value_note?: string;
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

// ─── Scarcity Analysis ────────────────────────────────────────────────────────

export interface ScarcityRequest {
  drafted_players: DraftedPlayer[];
  /** Narrow analysis to a single position, e.g. "SS" */
  position?: string;
  scoring_categories?: ScoringCategory[];
  league_scope?: LeagueScope;
  num_teams?: number;
}

export interface PositionScarcity {
  position: string;
  /** Tier 1 players still available */
  elite_remaining: number;
  /** Tier 2–3 players still available */
  mid_tier_remaining: number;
  /** Tier 4+ players still available */
  depth_remaining: number;
  total_remaining: number;
  /** 0–100; higher = more scarce */
  scarcity_score: number;
  alert: string | null;
}

export interface MonopolyWarning {
  team_id: string;
  category: string;
  controlled_players: string[];
  share_percentage: number;
  message: string;
}

export interface ScarcityResponse {
  engine_contract_version?: string;
  schema_version?: "2";
  calculated_at?: string;
  selected_position?: string;
  tier_buckets?: {
    position: string;
    buckets: {
      tier: string;
      remaining: number;
      urgency_score: number;
      message: string;
      recommended_action: string;
    }[];
  }[];
  selected_position_explainer?: {
    severity: "low" | "medium" | "high" | "critical";
    urgency_score: number;
    message: string;
    recommended_action: string;
  } | null;
  positions: PositionScarcity[];
  monopoly_warnings: MonopolyWarning[];
  analyzed_at: string;
}

// ─── Mock Pick Simulation ────────────────────────────────────────────────────

export interface MockPickRequest {
  /** Ordered fantasy team_ids for the current round */
  pick_order: string[];
  teams: MockPickTeam[];
  /** Optional explicit pool; defaults to all undrafted players */
  available_player_ids?: string[];
  roster_slots: RosterSlot[];
  league_scope?: LeagueScope;
}

export interface PredictedPick {
  team_id: string;
  pick_position: number;
  predicted_player: {
    player_id: string;
    name: string;
    position: string;
    adp: number;
    reason: string;
  };
  /** 0–1 confidence score */
  confidence: number;
}

export interface MockPickResponse {
  predictions: PredictedPick[];
  simulated_at: string;
}

// ─── News / Structural Signals ────────────────────────────────────────────────

export type SignalType =
  | "injury"
  | "role_change"
  | "trade"
  | "demotion"
  | "promotion";

export type SignalSeverity = "low" | "medium" | "high";

export interface NewsSignal {
  player_id?: string;
  player_name: string;
  signal_type: SignalType;
  severity: SignalSeverity;
  description: string;
  effective_date: string;
  source: string;
}

export interface SignalsResponse {
  signals: NewsSignal[];
  fetched_at: string;
  count: number;
}

// ─── Catalog / batch baseline values ─────────────────────────────────────────

export interface CatalogBatchValuesRequest {
  /** MLB person ids as strings (same as `player_id` / `mlbId`). */
  player_ids: string[];
  league_scope?: LeagueScope;
  /** Reserved for future eligibility alignment with Draft catalog rules. */
  pos_eligibility_threshold?: number;
}

export interface CatalogPlayerValueRow {
  player_id: string;
  name: string;
  position: string;
  team: string;
  value: number;
  tier: number;
  adp: number;
}

export interface CatalogBatchValuesResponse {
  engine_contract_version: string;
  players: CatalogPlayerValueRow[];
}
