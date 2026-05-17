/**
 * Confirm context_v2.market_pressure on live Engine (pre_draft fixture).
 */
import "dotenv/config";
import { config } from "dotenv";
import { readFileSync } from "fs";
import path from "path";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import { resolveDraftCheckpointFixturePath } from "../src/lib/checkpointSlotReconciliation";

config({ path: path.resolve(__dirname, "../../AmethystDraft/apps/api/.env") });

async function main() {
  const base = (
    process.env.AMETHYST_API_URL ??
    "https://q6dbuvmuvh.us-east-1.awsapprunner.com"
  ).replace(/\/$/, "");
  const key = process.env.AMETHYST_API_KEY;
  if (!key) throw new Error("AMETHYST_API_KEY required");

  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8")
  );
  const body = {
    ...buildNormalizedFromNested(nestedValuationBodySchema.parse(raw)),
    inflation_model: "replacement_slots_v2" as const,
    auction_curve_model: "adaptive_surplus_v1" as const,
    deterministic: true,
    seed: 42,
  };
  const res = await fetch(`${base}/valuation/calculate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const mp = data.context_v2?.market_pressure;
  console.log(
    JSON.stringify(
      {
        has_market_pressure: Boolean(mp),
        market_inflation: mp?.market_inflation?.status,
        budget_pressure: mp?.budget_pressure?.status,
        keeper_compression: mp?.keeper_compression?.status,
        allocator_label: mp?.allocator_vs_open?.label,
      },
      null,
      2
    )
  );
}

main();
