import mongoose, { Document, Schema } from "mongoose";

export interface IWatchlistEntry extends Document {
  leagueId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  externalPlayerId: string;
  playerName: string;
  personalRank: number | null;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

const watchlistEntrySchema = new Schema<IWatchlistEntry>(
  {
    leagueId: {
      type: Schema.Types.ObjectId,
      ref: "League",
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    externalPlayerId: {
      type: String,
      required: true,
    },
    playerName: {
      type: String,
      required: true,
    },
    personalRank: {
      type: Number,
      default: null,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

// Compound index: one watchlist entry per player per user per league
watchlistEntrySchema.index(
  { leagueId: 1, userId: 1, externalPlayerId: 1 },
  { unique: true }
);

export default mongoose.model<IWatchlistEntry>("WatchlistEntry", watchlistEntrySchema);