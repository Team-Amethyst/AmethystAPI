import mongoose, { Document, Schema, Types } from "mongoose";

export interface IDeveloperAccount extends Document {
  displayName: string;
  normalizedName: string;
  contactEmail: string | null;
  organization: string | null;
  isActive: boolean;
  createdByApiKeyId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const developerAccountSchema = new Schema<IDeveloperAccount>(
  {
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    normalizedName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    contactEmail: {
      type: String,
      required: false,
      default: null,
      trim: true,
      lowercase: true,
      index: true,
      sparse: true,
    },
    organization: {
      type: String,
      required: false,
      default: null,
      trim: true,
      maxlength: 200,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdByApiKeyId: {
      type: Schema.Types.ObjectId,
      ref: "ApiKey",
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IDeveloperAccount>("DeveloperAccount", developerAccountSchema);
