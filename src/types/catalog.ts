import type { LeagueScope } from "./core";

export interface CatalogBatchValuesRequest {
  player_ids: string[];
  league_scope?: LeagueScope;
  pos_eligibility_threshold?: number;
}

export interface CatalogPlayerValueRow {
  player_id: string;
  name: string;
  position: string;
  team: string;
  value: number;
  catalog_tier: number;
  catalog_rank: number;
}

export interface CatalogBatchValuesResponse {
  engine_contract_version: string;
  players: CatalogPlayerValueRow[];
}
