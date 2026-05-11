/** How a vendor row was linked to a catalog player (dry-run / preview only). */
export type MarketAdpMatchConfidence =
  | "mlb_id"
  | "exact_name_team_position"
  | "exact_name_position_team_unknown"
  | "exact_name_position_team_mismatch_unique"
  | "ambiguous"
  | "unmatched";

export interface MarketAdpVendorRow {
  /** Present when vendor feed includes a draft rank (e.g. NFBC data.php). */
  vendor_rank?: number;
  mlb_id?: number | null;
  name: string;
  team: string;
  position: string;
  adp: number;
  adp_min?: number | null;
  adp_max?: number | null;
  sample_size?: number | null;
}

export type DryRunMatch =
  | {
      kind: "matched";
      vendor: MarketAdpVendorRow;
      catalog_player_id: string;
      mlb_id?: number | null;
      match_confidence: MarketAdpMatchConfidence;
    }
  | {
      kind: "ambiguous";
      vendor: MarketAdpVendorRow;
      candidate_player_ids: string[];
      match_confidence: "ambiguous";
    }
  | {
      kind: "unmatched_vendor";
      vendor: MarketAdpVendorRow;
      reason: string;
      match_confidence: "unmatched";
    };

export interface ProposedCatalogUpdate {
  mlb_id?: number | null;
  player_id: string;
  set: Record<string, unknown>;
  match_confidence?: MarketAdpMatchConfidence;
}

export interface MarketAdpAdapterContext {
  sourceName: string;
  fetchedAt: string;
}

/** Pluggable vendor fetch + normalization (CSV fixture, HTTP API, etc.). */
export interface MarketAdpAdapter {
  id: string;
  displayName: string;
  fetchRows(ctx: MarketAdpAdapterContext): Promise<MarketAdpVendorRow[]>;
}
