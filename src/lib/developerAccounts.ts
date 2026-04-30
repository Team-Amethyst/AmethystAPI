import { Types } from "mongoose";
import DeveloperAccount, { IDeveloperAccount } from "../models/DeveloperAccount";
import { NotFoundError, ValidationError } from "./appError";

export interface ResolveDeveloperAccountInput {
  developerAccountId?: unknown;
  owner?: unknown;
  email?: unknown;
  organization?: unknown;
}

function normalizeName(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function resolveDeveloperAccount(
  input: ResolveDeveloperAccountInput
): Promise<IDeveloperAccount> {
  const providedId =
    typeof input.developerAccountId === "string" ? input.developerAccountId.trim() : "";

  if (providedId) {
    if (!Types.ObjectId.isValid(providedId)) {
      throw new ValidationError("developerAccountId is not a valid id.", 400, "DEVELOPER_ACCOUNT_ID_INVALID");
    }
    const existing = await DeveloperAccount.findById(providedId);
    if (!existing || !existing.isActive) {
      throw new NotFoundError("Developer account not found.", 404, "DEVELOPER_ACCOUNT_NOT_FOUND");
    }
    return existing;
  }

  const owner = typeof input.owner === "string" ? input.owner.trim() : "";
  if (!owner) {
    throw new ValidationError("owner is required to create a developer account.", 400, "DEVELOPER_OWNER_REQUIRED");
  }
  const normalizedName = normalizeName(owner);
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const organization =
    typeof input.organization === "string" && input.organization.trim().length > 0
      ? input.organization.trim()
      : null;

  if (email) {
    const byEmail = await DeveloperAccount.findOne({ contactEmail: email, isActive: true });
    if (byEmail) {
      return byEmail;
    }
  }

  const byName = await DeveloperAccount.findOne({ normalizedName, isActive: true });
  if (byName) {
    if (email && !byName.contactEmail) {
      byName.contactEmail = email;
      await byName.save();
    }
    return byName;
  }

  return DeveloperAccount.create({
    displayName: owner,
    normalizedName,
    contactEmail: email || null,
    organization,
    isActive: true,
  });
}
