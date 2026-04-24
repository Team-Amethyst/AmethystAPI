import mongoose from "mongoose";
import { logger } from "./logger";

/**
 * Best-effort fixes for legacy Atlas `apikeys` collections:
 * - Turn document validation off (strict JSON Schema blocks hashed rows).
 * - Drop a unique index on `key` alone (hashed keys omit `key`; multiple nulls violate unique).
 *
 * Requires Mongo privileges; failures are logged and ignored.
 */
export async function relaxApiKeysCollectionValidation(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;

  try {
    const cols = await db.listCollections({ name: "apikeys" }).toArray();
    if (cols.length === 0) {
      return;
    }

    try {
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

    try {
      const indexes = await db.collection("apikeys").indexes();
      for (const idx of indexes) {
        const keys = idx.key ? Object.keys(idx.key) : [];
        const isKeyOnlyUnique =
          idx.unique === true && keys.length === 1 && keys[0] === "key";
        if (isKeyOnlyUnique && idx.name) {
          await db.collection("apikeys").dropIndex(idx.name);
          logger.info(
            { dropped: idx.name },
            "Dropped legacy unique index on apikeys.key (hashed keys use keyHash)"
          );
          break;
        }
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "apikeys legacy key index drop skipped (no permission or index absent)"
      );
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "apikeys collection compatibility hooks failed"
    );
  }
}
