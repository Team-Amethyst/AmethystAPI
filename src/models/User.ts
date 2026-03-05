import mongoose, { Document, Schema } from "mongoose";
import bcrypt from "bcryptjs";

export interface IUser extends Document {
  username: string;
  email: string;
  passwordHash: string;
  lastLogin: Date | null;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Hash password before saving.
// Avoid async in pre("save") to sidestep Mongoose overload conflicts --
// use an explicit Promise return instead.
userSchema.pre("save", function (): Promise<void> {
  if (!this.isModified("passwordHash")) return Promise.resolve();
  return bcrypt.hash(this.passwordHash, 12).then((hash) => {
    this.passwordHash = hash;
  });
});

// Compare password helper method
userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

export default mongoose.model<IUser>("User", userSchema);