export type CatalogValuationTier = "valuation_eligible" | "market_only" | "roster_context";

export type RosterTypeParam = "40Man" | "active" | "fullSeason";

export type CatalogUniverseSpotlightRow = {
  label: string;
  mlbId: number;
  in_roster_pool: boolean;
  in_nfbc_preview_pool: boolean;
  in_candidate_universe: boolean;
  catalogValuationTier?: string;
  absent_from_capped_seed_first_page: boolean;
  name_from_catalog?: string;
};

export type CatalogUniverseDryRunReport = {
  generatedAt: string;
  anchor_season: number;
  blend_seasons: number[];
  roster_types_used: RosterTypeParam[];
  /** Union(roster, NFBC sources) after dedupe — total candidates. */
  candidate_count: number;
  /** Distinct MLB IDs from roster endpoint crawl. */
  roster_candidate_count: number;
  /** Distinct MLB IDs parsed from NFBC market ADP preview JSON only. */
  nfbc_preview_candidate_count: number;
  /** Distinct MLB IDs from Mongo market ADP merge (0 when preview-only dry-run). */
  nfbc_mongo_candidate_count: number;
  /** |roster ∩ preview NFBC|. */
  overlap_roster_nfbc_preview_count: number;
  /** |roster ∩ (preview ∪ mongo NFBC)|. */
  overlap_roster_nfbc_total_count: number;
  /** Candidates on roster but not in any NFBC id source (preview ∪ mongo). */
  roster_only_count: number;
  /** Candidates in NFBC sources but not on any crawled roster row. */
  nfbc_only_count: number;
  valuation_eligible_count: number;
  market_only_count: number;
  roster_context_count: number;
  missing_projection_count: number;
  /** MLB IDs in candidate set not present in paginated season stat maps for anchor year (both sides). */
  anchor_stats_absent_count: number;
  /** Candidates absent from both capped first pages (400 hit / 300 pit) — universe wider than legacy seed. */
  newly_included_not_on_capped_first_page_count: number;
  /** Sample MLB IDs not on capped first page (capped to 40). */
  newly_included_vs_capped_seed_sample: number[];
  /** Fantasy audit names — presence in candidate pool and tier after build. */
  spotlight_players: CatalogUniverseSpotlightRow[];
};
