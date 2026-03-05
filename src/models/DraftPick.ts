import mongoose, { Document, Schema } from "mongoose";

export interface IDraftPick extends Document {
  leagueId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  externalPlayerId: string;
  playerName: string;
  price: number;
  pickNumber: number;
  nominatedBy: mongoose.Types.ObjectId | null;
  pickedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const draftPickSchema = new Schema<IDraftPick>(
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
    price: {
      type: Number,
      required: true,
      min: 1,
    },
    pickNumber: {
      type: Number,
      required: true,
    },
    nominatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    pickedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Compound index: one pick per player per league
draftPickSchema.index(
  { leagueId: 1, externalPlayerId: 1 },
  { unique: true }
);

export default mongoose.model<IDraftPick>("DraftPick", draftPickSchema);