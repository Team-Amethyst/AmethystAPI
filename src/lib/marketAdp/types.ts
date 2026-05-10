export interface MarketAdpVendorRow {
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
    }
  | {
      kind: "ambiguous";
      vendor: MarketAdpVendorRow;
      candidate_player_ids: string[];
    }
  | {
      kind: "unmatched_vendor";
      vendor: MarketAdpVendorRow;
      reason: string;
    };

export interface ProposedCatalogUpdate {
  mlb_id?: number | null;
  player_id: string;
  set: Record<string, unknown>;
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
