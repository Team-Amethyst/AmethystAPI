import mongoose, { Document, Schema } from "mongoose";

export type ApiKeyTier = "free" | "standard" | "premium";

export interface IApiKey extends Document {
  key: string;
  /** Name or identifier of the licensee */
  owner: string;
  email?: string;
  /** License tier — affects rate limits and feature access */
  tier: ApiKeyTier;
  /** Cumulative request count used for royalty reporting (5% net revenue model) */
  usageCount: number;
  lastUsed: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const apiKeySchema = new Schema<IApiKey>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    owner: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    tier: {
      type: String,
      enum: ["free", "standard", "premium"] as ApiKeyTier[],
      default: "free",
    },
    usageCount: {
      type: Number,
      default: 0,
    },
    lastUsed: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IApiKey>("ApiKey", apiKeySchema);
