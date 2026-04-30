import { Router, RequestHandler } from "express";
import DeveloperAccount from "../models/DeveloperAccount";
import { ValidationError } from "../lib/appError";

const router = Router();

const listDevelopers: RequestHandler = async (_req, res, next) => {
  try {
    const rows = await DeveloperAccount.find({ isActive: true }).sort({ createdAt: -1 }).lean();
    res.json(
      rows.map((row) => ({
        id: row._id,
        displayName: row.displayName,
        contactEmail: row.contactEmail ?? null,
        organization: row.organization ?? null,
        isActive: row.isActive,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }))
    );
  } catch (err) {
    next(err);
  }
};

const createDeveloper: RequestHandler = async (req, res, next) => {
  const body = req.body as Record<string, unknown>;
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const email = typeof body?.contactEmail === "string" ? body.contactEmail.trim().toLowerCase() : "";
  const organization = typeof body?.organization === "string" ? body.organization.trim() : "";

  if (!displayName) {
    return next(new ValidationError("displayName is required.", 400, "DEVELOPER_DISPLAY_NAME_REQUIRED"));
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return next(new ValidationError("contactEmail format is invalid.", 400, "DEVELOPER_EMAIL_INVALID"));
  }

  try {
    const existingByEmail = email
      ? await DeveloperAccount.findOne({ contactEmail: email, isActive: true }).lean()
      : null;
    if (existingByEmail) {
      return res.status(200).json({
        id: existingByEmail._id,
        displayName: existingByEmail.displayName,
        contactEmail: existingByEmail.contactEmail ?? null,
        organization: existingByEmail.organization ?? null,
        isActive: existingByEmail.isActive,
        createdAt: existingByEmail.createdAt,
        updatedAt: existingByEmail.updatedAt,
      });
    }

    const normalizedName = displayName.toLowerCase().replace(/\s+/g, " ");
    const existingByName = await DeveloperAccount.findOne({ normalizedName, isActive: true }).lean();
    if (existingByName) {
      return res.status(200).json({
        id: existingByName._id,
        displayName: existingByName.displayName,
        contactEmail: existingByName.contactEmail ?? null,
        organization: existingByName.organization ?? null,
        isActive: existingByName.isActive,
        createdAt: existingByName.createdAt,
        updatedAt: existingByName.updatedAt,
      });
    }

    const created = await DeveloperAccount.create({
      displayName,
      normalizedName,
      contactEmail: email || null,
      organization: organization || null,
      isActive: true,
    });
    res.status(201).json({
      id: created._id,
      displayName: created.displayName,
      contactEmail: created.contactEmail ?? null,
      organization: created.organization ?? null,
      isActive: created.isActive,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
  } catch (err) {
    next(err);
  }
};

router.get("/", listDevelopers);
router.post("/", createDeveloper);

export default router;
