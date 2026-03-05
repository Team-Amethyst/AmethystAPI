import mongoose, { Document, Schema } from "mongoose";

export type DraftStatus = "pre-draft" | "in-progress" | "completed";
export type ScoringFormat = "5x5" | "6x6" | "points";

// Roster slots stored as a plain object instead of Map to avoid TS schema conflicts
export interface IRosterSlots {
  [key: string]: number;
}

export interface ILeague extends Document {
  name: string;
  commissionerId: mongoose.Types.ObjectId;
  memberIds: mongoose.Types.ObjectId[];
  budget: number;
  hitterBudgetPct: number;
  teams: number;
  scoringFormat: ScoringFormat;
  rosterSlots: IRosterSlots;
  draftStatus: DraftStatus;
  createdAt: Date;
  updatedAt: Date;
}

const leagueSchema = new Schema<ILeague>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    commissionerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    memberIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    budget: {
      type: Number,
      default: 260,
    },
    hitterBudgetPct: {
      type: Number,
      default: 70,
    },
    teams: {
      type: Number,
      default: 12,
    },
    scoringFormat: {
      type: String,
      enum: ["5x5", "6x6", "points"],
      default: "5x5",
    },
    // Using Schema.Types.Mixed for flexible key-value roster slot config
    rosterSlots: {
      type: Schema.Types.Mixed,
      default: {
        C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1,
        OF: 3, UTIL: 1, SP: 2, RP: 2, P: 3, BN: 5,
      },
    },
    draftStatus: {
      type: String,
      enum: ["pre-draft", "in-progress", "completed"],
      default: "pre-draft",
    },
  },
  { timestamps: true }
);

export default mongoose.model<ILeague>("League", leagueSchema);