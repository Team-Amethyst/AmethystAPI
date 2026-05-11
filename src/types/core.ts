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
  /** Internal catalog sort order (not market ADP). */
  catalog_rank?: number;
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

/** Gates auction / inflation pools vs research-only catalog rows (roster universe v1). */
export type CatalogValuationTier = "valuation_eligible" | "market_only" | "roster_context";

export interface LeanPlayer {
  _id: unknown;
  mlbId?: number;
  /** MLB sync rows vs explicitly tagged manual/custom catalog entries (may omit mlbId). */
  catalogKind?: "mlb" | "custom";
  name: string;
  team: string;
  position: string;
  positions?: string[];
  age?: number;
  depthChartPosition?: number;
  /** 0 healthy/unknown; 1 day-to-day; 2 IL short; 3 long-term — used in baseline injury haircut. */
  injurySeverity?: number;
  /** Rank by catalog/preseason model value (sync assigns from sorted pool). Not market ADP. */
  catalog_rank: number;
  /** Tier from catalog dollar bands (`assignTier` / Mongo). Not auction-tier. */
  catalog_tier: number;
  value: number;
  /** External fantasy ADP from an ingested vendor source (optional). Never derived from catalog_rank. */
  market_adp?: number;
  market_adp_source?: string;
  market_adp_updated_at?: string;
  market_adp_min?: number;
  market_adp_max?: number;
  market_pick_count?: number;
  outlook?: string;
  stats?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  /** When absent, legacy rows are treated as `valuation_eligible` if `isValuationEligibleCatalogRow` passes. */
  catalogValuationTier?: CatalogValuationTier;
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
