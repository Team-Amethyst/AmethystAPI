/**
 * List player_id values from a checkpoint that are missing from Mongo `Player` (by mlbId).
 * Requires MONGO_URI. Helps align draft fixtures with catalog sync.
 *
 * Usage: pnpm check-fixture-catalog
 */
import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import Player from "../src/models/Player";

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CHECKPOINT = path.join(
  ROOT,
  "test-fixtures/player-api/checkpoints/after_pick_130.json"
);

function collectAllPlayerIds(body: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const addRows = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (typeof row !== "object" || row == null) continue;
      const pid = (row as { player_id?: string }).player_id;
      if (typeof pid === "string" && pid.length > 0) ids.add(pid);
    }
  };
  addRows(body.drafted_players);
  const pre = body.pre_draft_rosters;
  if (Array.isArray(pre)) {
    for (const bucket of pre) {
      addRows((bucket as { players?: unknown }).players);
    }
  } else if (pre && typeof pre === "object") {
    for (const rows of Object.values(pre as Record<string, unknown>)) {
      addRows(rows);
    }
  }
  for (const key of ["minors", "taxi"] as const) {
    const b = body[key];
    if (!Array.isArray(b)) continue;
    for (const bucket of b) {
      addRows((bucket as { players?: unknown }).players);
    }
  }
  return ids;
}

async function main(): Promise<void> {
  const cp =
    process.argv.find((a) => a.endsWith(".json") && a.includes("checkpoint")) ??
    process.argv.find((a) => a.endsWith(".json")) ??
    DEFAULT_CHECKPOINT;
  const filePath = path.isAbsolute(cp) ? cp : path.join(ROOT, cp);
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const ids = [...collectAllPlayerIds(raw)].sort();
  const uri = process.env.MONGO_URI?.trim();
  if (!uri) throw new Error("MONGO_URI missing");

  await mongoose.connect(uri);
  try {
    const nums = ids
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n < 9_000_000);
    const synth = ids.filter((s) => {
      const n = Number(s);
      return Number.isFinite(n) && n >= 9_000_000;
    });
    const found = await Player.find({
      mlbId: { $in: nums },
    })
      .select("mlbId")
      .lean()
      .exec();
    const have = new Set(
      (found as { mlbId?: number }[]).map((d) => String(d.mlbId))
    );
    const missingMongo = ids.filter((id) => !have.has(id) && !synth.includes(id));
    const summary = {
      checkpoint: filePath,
      unique_ids: ids.length,
      synthetic_stub_ids: synth.length,
      missing_in_mongo_count: missingMongo.length,
      missing_in_mongo_sample: missingMongo.slice(0, 40),
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
