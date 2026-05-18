import { readFileSync } from "fs";
import { resolveDraftCheckpointFixturePath } from "../checkpointSlotReconciliation";
import type { EngineCheckpointId } from "../checkpointSlotReconciliation";
import type { ValuationResponse } from "../../types/valuation";
import { buildNormalizedFromNested } from "../valuationRequestNormalization";
import { nestedValuationBodySchema } from "../valuationRequestSchemas";
import { workflowBody } from "./helpers";

function engineBaseUrl(): string {
  const url = (
    process.env.AMETHYST_API_URL ??
    process.env.AMETHYST_API_BASE_URL ??
    ""
  ).replace(/\/$/, "");
  if (!url) {
    throw new Error("Set AMETHYST_API_URL for HTTP engine audit mode");
  }
  return url;
}

function apiKey(): string {
  const key = process.env.AMETHYST_API_KEY?.trim();
  if (!key) throw new Error("Set AMETHYST_API_KEY for HTTP engine audit mode");
  return key;
}

/** POST nested canonical checkpoint to live Engine (production catalog on server). */
export async function fetchCheckpointValuation(
  cp: EngineCheckpointId,
): Promise<ValuationResponse> {
  const raw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath(cp), "utf8"),
  );
  const nested = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
  const body = { ...raw, ...workflowBody(nested) };
  const paths = ["/v1/valuation/calculate", "/valuation/calculate"];
  let lastErr = "";
  for (const path of paths) {
    const res = await fetch(`${engineBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey(),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      return JSON.parse(text) as ValuationResponse;
    }
    lastErr = `${path} ${res.status}: ${text.slice(0, 200)}`;
    if (res.status !== 404) break;
  }
  throw new Error(`Engine HTTP failed for ${cp}: ${lastErr}`);
}

export async function mongoCatalogUsable(): Promise<boolean> {
  const uri = process.env.MONGO_URI?.trim();
  if (!uri) return false;
  try {
    const mongoose = await import("mongoose");
    const Player = (await import("../../models/Player")).default;
    const { scriptMongoConnectOptions } = await import("../mongoPoolConfig");
    await mongoose.default.connect(uri, scriptMongoConnectOptions());
    const n = await Player.countDocuments({ valuation_eligible: true });
    await mongoose.default.disconnect();
    return n >= 100;
  } catch {
    return false;
  }
}
