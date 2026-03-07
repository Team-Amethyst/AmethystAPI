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
  };
  pitching?: {
    era?: string;
    whip?: string;
    wins?: number;
    saves?: number;
    strikeouts?: number;
  };
}

export interface IPlayer extends Document {
  /** Numeric MLB player ID — matches the id Draftroom fetches from MLB Stats API */
  mlbId?: number;
  name: string;
  team: string;
  position: string;
  age: number;
  adp: number;
  tier: number;
  value: number;
  outlook: string;
  stats?: IPlayerStats;
  projection?: IPlayerProjection;
}

const playerSchema = new Schema<IPlayer>(
  {
    mlbId: { type: Number, index: true, sparse: true },
    name: { type: String, required: true, trim: true },
    team: { type: String, default: "" },
    position: { type: String, default: "" },
    age: { type: Number, default: 0 },
    adp: { type: Number, default: 0 },
    tier: { type: Number, default: 0 },
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

export default mongoose.models.Player || mongoose.model<IPlayer>("Player", playerSchema);
