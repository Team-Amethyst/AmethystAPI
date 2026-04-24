import mongoose, { Document, Schema } from "mongoose";
import { ApiKeyScope } from "../lib/apiKey";

export type ApiKeyTier = "free" | "standard" | "premium";

export interface IApiKey extends Document {
  keyHash: string;
  key?: string;
  keyPrefix: string;
  label: string;
  owner: string;
  /** Optional; unique synthetic value may be assigned for legacy Mongo unique indexes on email */
  email?: string;
  tier: ApiKeyTier;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
  usageCount: number;
  lastUsed: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const apiKeySchema = new Schema<IApiKey>(
  {
    keyHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    key: {
      type: String,
      required: false,
      select: false,
    },
    keyPrefix: {
      type: String,
      required: true,
      index: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    owner: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: false,
      lowercase: true,
      trim: true,
    },
    tier: {
      type: String,
      enum: ["free", "standard", "premium"] as ApiKeyTier[],
      default: "free",
    },
    scopes: {
      type: [String],
      default: [],
    },
    expiresAt: {
      type: Date,
      default: null,
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
