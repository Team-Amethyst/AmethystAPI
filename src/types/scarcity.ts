import type {
  DraftedPlayer,
  LeagueScope,
  ScoringCategory,
} from "./core";

export interface ScarcityRequest {
  drafted_players: DraftedPlayer[];
  position?: string;
  scoring_categories?: ScoringCategory[];
  league_scope?: LeagueScope;
  num_teams?: number;
}

export interface PositionScarcity {
  position: string;
  elite_remaining: number;
  mid_tier_remaining: number;
  depth_remaining: number;
  total_remaining: number;
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
