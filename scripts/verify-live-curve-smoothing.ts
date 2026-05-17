/**
 * POST checkpoint fixtures to live Engine and print curve metrics.
 *
 *   npx tsx scripts/verify-live-curve-smoothing.ts
 */
import "dotenv/config";
import { config } from "dotenv";
import { readFileSync } from "fs";
import path from "path";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import {
  resolveDraftCheckpointFixturePath,
  type EngineCheckpointId,
} from "../src/lib/checkpointSlotReconciliation";

config({ path: path.resolve(__dirname, "../../AmethystDraft/apps/api/.env") });

const CHECKPOINTS: EngineCheckpointId[] = [
  "pre_draft",
  "after_pick_10",
];

async function main() {
  const base = (
    process.env.AMETHYST_API_URL ??
    process.env.AMETHYST_API_BASE_URL ??
    ""
  ).replace(/\/$/, "");
  const key = process.env.AMETHYST_API_KEY;
  if (!base || !key) throw new Error("Set AMETHYST_API_URL and AMETHYST_API_KEY");

  for (const cp of CHECKPOINTS) {
    const raw = JSON.parse(
      readFileSync(resolveDraftCheckpointFixturePath(cp), "utf8")
    );
    const input = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
    const body = {
      ...input,
      inflation_model: "replacement_slots_v2" as const,
      auction_curve_model: "adaptive_surplus_v1" as const,
      deterministic: true,
      seed: 42,
      explain_valuation_rows: true,
    };
    const res = await fetch(`${base}/valuation/calculate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${cp} ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      valuations: { auction_value: number; name: string }[];
      internal_allocation_mode?: string;
      auction_curve_reason?: string;
      curve_guardrails_applied?: string[];
    };
    const sorted = [...data.valuations]
      .sort((a, b) => b.auction_value - a.auction_value)
      .slice(0, 75);
    let maxDrop = 0;
    for (let i = 1; i < sorted.length; i++) {
      maxDrop = Math.max(
        maxDrop,
        sorted[i - 1]!.auction_value - sorted[i]!.auction_value
      );
    }
    const plateau48 = sorted.filter((v) => Math.round(v.auction_value) === 48)
      .length;
    console.log(`\n=== LIVE ${cp} ===`);
    console.log({
      internal_allocation_mode: data.internal_allocation_mode,
      auction_curve_reason: data.auction_curve_reason,
      curve_guardrails_applied: data.curve_guardrails_applied,
      top1: sorted[0]?.auction_value,
      max_adjacent_drop_top75: maxDrop,
      count_at_48_top75: plateau48,
    });
    console.log(
      "ranks 34-40:",
      sorted.slice(33, 40).map((v, i) => ({
        rank: 34 + i,
        raw: v.auction_value,
        ui: Math.round(v.auction_value),
        name: v.name,
      }))
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
