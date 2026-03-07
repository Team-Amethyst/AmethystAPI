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

export interface DraftedPlayer {
  player_id: string;
  name: string;
  position: string;
  /** MLB team abbreviation, e.g. "NYY", "BOS" */
  team: string;
  /** Fantasy team identifier */
  team_id: string;
  /** Auction price paid */
  paid?: number;
  adp?: number;
}

export interface MockPickTeam {
  team_id: string;
  roster: DraftedPlayer[];
  budget_remaining?: number;
}

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
  indicator: ValueIndicator;
  inflation_factor: number;
}

export interface ValuationResponse {
  /** > 1.0 = inflated market; < 1.0 = deflated */
  inflation_factor: number;
  total_budget_remaining: number;
  pool_value_remaining: number;
  players_remaining: number;
  valuations: ValuedPlayer[];
  calculated_at: string;
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
  positions: PositionScarcity[];
  monopoly_warnings: MonopolyWarning[];
  analyzed_at: string;
}

// ─── Mock Pick Simulation ─────────────────────────────────────────────────────

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
