import mongoose from "mongoose";
import { logger } from "./logger";

/**
 * If the `apikeys` collection has a strict JSON Schema validator (common on Atlas
 * course clusters), inserts with `keyHash` / `keyPrefix` can fail. Attempt to turn
 * validation off for this collection only — requires a privileged Mongo user; no-op
 * if the command is not permitted or unsupported.
 */
export async function relaxApiKeysCollectionValidation(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;

  try {
    const cols = await db.listCollections({ name: "apikeys" }).toArray();
    if (cols.length === 0) {
      return;
    }

    await db.command({
      collMod: "apikeys",
      validationLevel: "off",
    });
    logger.info("apikeys collection document validation set to off (collMod succeeded)");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "apikeys collMod skipped (no permission, no validator, or unsupported)"
    );
  }
}
