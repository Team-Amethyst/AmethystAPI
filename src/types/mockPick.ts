import type {
  LeagueScope,
  MockPickTeam,
  RosterSlot,
} from "./core";

export interface MockPickRequest {
  pick_order: string[];
  teams: MockPickTeam[];
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
  confidence: number;
}

export interface MockPickResponse {
  predictions: PredictedPick[];
  simulated_at: string;
}
