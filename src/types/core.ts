export type LeagueScope = "Mixed" | "AL" | "NL";

export interface RosterSlot {
  position: string;
  count: number;
}

export interface ScoringCategory {
  name: string;
  type: "batting" | "pitching";
}

export interface DraftedPlayer {
  player_id: string;
  name: string;
  position: string;
  positions?: string[];
  team: string;
  team_id: string;
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

export interface TeamRosterBucket {
  team_id: string;
  players: DraftedPlayer[];
}

export type ScoringFormat = "5x5" | "6x6" | "points";

export interface LeanPlayer {
  _id: unknown;
  mlbId?: number;
  name: string;
  team: string;
  position: string;
  positions?: string[];
  adp: number;
  tier: number;
  value: number;
  outlook?: string;
  stats?: Record<string, unknown>;
  projection?: Record<string, unknown>;
}

export type InflationModel =
  | "global_v1"
  | "surplus_slots_v1"
  | "replacement_slots_v2";

export type ValueIndicator = "Steal" | "Reach" | "Fair Value";
export type DraftPhaseIndicator = "early" | "mid" | "late";
export type InflationBoundedBy = "none" | "cap" | "floor";

export type SignalType =
  | "injury"
  | "role_change"
  | "trade"
  | "demotion"
  | "promotion";

export type SignalSeverity = "low" | "medium" | "high";
