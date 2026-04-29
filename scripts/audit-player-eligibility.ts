import mongoose from "mongoose";
import dotenv from "dotenv";
import Player from "../src/models/Player";
import { tokenizeFantasyPositions } from "../src/lib/fantasyRosterSlots";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI not set in .env");
  process.exit(1);
}

type RawPlayer = {
  mlbId?: number;
  name?: string;
  position?: string;
  positions?: unknown;
  value?: number;
};

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(/[,/|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

async function run() {
  await mongoose.connect(MONGO_URI as string);

  const docs = (await Player.find({})
    .select("mlbId name position positions value")
    .lean()
    .exec()) as RawPlayer[];

  let missingPosition = 0;
  let emptyTokenization = 0;
  let missingSecondaryOnHighValue = 0;
  let twpLikeRows = 0;
  let twpExpanded = 0;
  const offenders: string[] = [];

  for (const d of docs) {
    const position = typeof d.position === "string" ? d.position : "";
    const positions = asStringArray(d.positions);
    const tokens = tokenizeFantasyPositions(position, positions);
    const value = typeof d.value === "number" ? d.value : 0;
    const label = `${d.name ?? "unknown"} (${d.mlbId ?? "?"})`;

    if (!position.trim()) {
      missingPosition += 1;
      if (offenders.length < 10) offenders.push(`${label}: missing position`);
    }
    if (tokens.length === 0) {
      emptyTokenization += 1;
      if (offenders.length < 10) offenders.push(`${label}: no eligibility tokens`);
    }

    // Two-way-like rows should expose explicit DH/SP tokens post-normalization.
    const hasDh = tokens.includes("DH");
    const hasSp = tokens.includes("SP");
    if (hasDh || hasSp) {
      twpLikeRows += 1;
      if (hasDh && hasSp) twpExpanded += 1;
    }

    // High-value players should almost always carry secondary eligibility when known.
    if (value >= 40 && positions.length === 0) {
      missingSecondaryOnHighValue += 1;
      if (offenders.length < 10) {
        offenders.push(`${label}: value=${value} missing positions[]`);
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        total_players: docs.length,
        missing_position: missingPosition,
        empty_tokenization: emptyTokenization,
        high_value_missing_positions_array: missingSecondaryOnHighValue,
        twp_like_rows: twpLikeRows,
        twp_expanded_dh_sp: twpExpanded,
        sample_offenders: offenders,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();

  if (missingPosition > 0 || emptyTokenization > 0) {
    process.exit(2);
  }
}

run().catch((err) => {
  console.error("[audit:player-eligibility] Error:", err);
  process.exit(1);
});
