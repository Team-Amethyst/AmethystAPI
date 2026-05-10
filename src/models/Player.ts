import mongoose, { Document, Schema } from "mongoose";

interface IPlayerStats {
  batting?: {
    avg?: string;
    hr?: number;
    rbi?: number;
    runs?: number;
    sb?: number;
    obp?: string;
    slg?: string;
  };
  pitching?: {
    era?: string;
    whip?: string;
    wins?: number;
    saves?: number;
    strikeouts?: number;
    innings?: string;
  };
}

interface IPlayerProjection {
  batting?: {
    avg?: string;
    hr?: number;
    rbi?: number;
    runs?: number;
    sb?: number;
    /** Optional slugging rate string or number — synced / blended for SLG/OPS leagues. */
    slg?: string | number;
    /** Optional OPS — may be derived from OBP+SLG when absent from source. */
    ops?: string | number;
    /** Season projected total bases when available. */
    totalBases?: number;
    atBats?: number;
    plateAppearances?: number;
    obp?: string | number;
  };
  pitching?: {
    era?: string;
    whip?: string;
    wins?: number;
    saves?: number;
    strikeouts?: number;
    holds?: number;
    qualityStarts?: number;
    innings?: string | number;
  };
}

export interface IPlayer extends Document {
  /** Numeric MLB player ID — matches the id Draftroom fetches from MLB Stats API */
  mlbId?: number;
  /**
   * `mlb` = row produced by MLB Stats API sync (requires mlbId).
   * `custom` = manual / non-MLB catalog entry; may omit mlbId.
   */
  catalogKind?: "mlb" | "custom";
  name: string;
  team: string;
  position: string;
  /** Secondary fantasy eligibilities (sync from MLB splits + bio); optional. */
  positions?: string[];
  age: number;
  depthChartPosition?: number;
  injurySeverity?: number;
  /** Internal catalog sort order (sync); legacy Mongo key `adp` still ingested in normalizeCatalogPlayers. */
  catalog_rank: number;
  /** Catalog dollar-band tier (sync); legacy Mongo key `tier` still ingested. */
  catalog_tier: number;
  /** Optional vendor fantasy ADP when ingested (never derived from catalog_rank). */
  market_adp?: number;
  market_adp_source?: string;
  market_adp_updated_at?: string;
  market_adp_min?: number;
  market_adp_max?: number;
  market_pick_count?: number;
  value: number;
  outlook: string;
  stats?: IPlayerStats;
  projection?: IPlayerProjection;
}

const playerSchema = new Schema<IPlayer>(
  {
    mlbId: { type: Number },
    catalogKind: {
      type: String,
      enum: ["mlb", "custom"],
      index: true,
    },
    name: { type: String, required: true, trim: true },
    team: { type: String, default: "" },
    position: { type: String, default: "" },
    positions: { type: [String] },
    age: { type: Number, default: 0 },
    depthChartPosition: { type: Number },
    injurySeverity: { type: Number, min: 0, max: 3 },
    catalog_rank: { type: Number, default: 9999 },
    catalog_tier: { type: Number, default: 0 },
    market_adp: { type: Number },
    market_adp_source: { type: String },
    market_adp_updated_at: { type: String },
    market_adp_min: { type: Number },
    market_adp_max: { type: Number },
    market_pick_count: { type: Number },
    value: { type: Number, default: 0 },
    outlook: { type: String, default: "" },
    stats: { type: Schema.Types.Mixed, default: {} },
    projection: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "players",
    strict: false,
  }
);

playerSchema.index(
  { mlbId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      mlbId: { $type: "number", $gt: 0 },
    },
  }
);

export default mongoose.models.Player || mongoose.model<IPlayer>("Player", playerSchema);
