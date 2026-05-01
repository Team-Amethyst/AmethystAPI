import mongoose, { Document, Schema, Types } from "mongoose";

export interface IPortalUser extends Document {
  email: string;
  passwordHash: string;
  passwordSalt: string;
  displayName: string;
  developerAccountId: Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

const portalUserSchema = new Schema<IPortalUser>(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    passwordSalt: {
      type: String,
      required: true,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    developerAccountId: {
      type: Schema.Types.ObjectId,
      ref: "DeveloperAccount",
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IPortalUser>("PortalUser", portalUserSchema);
