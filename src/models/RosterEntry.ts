import mongoose, { Document, Schema } from "mongoose";

export interface IRosterEntry extends Document {
  leagueId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  externalPlayerId: string;
  playerName: string;
  playerTeam: string;
  positions: string[];
  price: number;
  rosterSlot: string;
  acquiredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const rosterEntrySchema = new Schema<IRosterEntry>(
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
    // External player ID from MLB Stats API or similar source.
    // This solves the duplicate name problem - always reference by ID.
    externalPlayerId: {
      type: String,
      required: true,
    },
    playerName: {
      type: String,
      required: true,
    },
    playerTeam: {
      type: String,
      default: "",
    },
    positions: [
      {
        type: String,
      },
    ],
    price: {
      type: Number,
      required: true,
      min: 1,
    },
    rosterSlot: {
      type: String,
      required: true, // e.g. "OF1", "SP2", "BN1"
    },
    acquiredAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Compound index: one player per team per league
rosterEntrySchema.index(
  { leagueId: 1, userId: 1, externalPlayerId: 1 },
  { unique: true }
);

export default mongoose.model<IRosterEntry>("RosterEntry", rosterEntrySchema);