/**
 * Post-deploy production Engine smoke (pre_draft fixture).
 *   AMETHYST_API_URL=... AMETHYST_API_KEY=... npx tsx scripts/production-engine-smoke.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ENGINE_URL = (process.env.AMETHYST_API_URL ?? "").replace(/\/$/, "");
const API_KEY = process.env.AMETHYST_API_KEY ?? "";
const FIXTURE = resolve(
  __dir,
  "../test-fixtures/player-api/checkpoints/pre_draft.json",
);

const TRACKED = [
  "Aaron Judge",
  "Julio Rodríguez",
  "Bobby Witt Jr.",
  "José Ramírez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Tarik Skubal",
  "Anthony Volpe",
  "Austin Wells",
  "Will Warren",
  "Camilo Doval",
  "Fernando Cruz",
  "Spencer Jones",
];

async function main() {
  if (!ENGINE_URL || !API_KEY) {
    throw new Error("Set AMETHYST_API_URL and AMETHYST_API_KEY");
  }
  const health = await fetch(`${ENGINE_URL}/api/health`).then((r) => r.json());
  const body = {
    ...JSON.parse(readFileSync(FIXTURE, "utf8")),
    deterministic: true,
    seed: 42,
    explain_valuation_rows: true,
    inflation_model: "replacement_slots_v2",
    auction_curve_model: "adaptive_surplus_v1",
  };
  const res = await fetch(`${ENGINE_URL}/v1/valuation/calculate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`valuation failed ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    inflation_model?: string;
    auction_curve_model?: string;
    valuation_model_version?: string;
    replacement_values_by_slot_or_position?: Record<string, number>;
    draftable_player_ids?: string[];
    valuations?: Array<{
      player_id: string;
      name: string;
      auction_value?: number;
      valuation_explain?: {
        replacement_key_used?: string;
        replacement_value_used?: number;
        surplus_basis?: number;
      };
    }>;
  };
  const repl = data.replacement_values_by_slot_or_position ?? {};
  const draftable = new Set(data.draftable_player_ids ?? []);
  const players = TRACKED.map((name) => {
    const v = data.valuations?.find((x) => x.name === name);
    const ve = v?.valuation_explain;
    return {
      name,
      replacement_key_used: ve?.replacement_key_used ?? null,
      replacement_value_used: ve?.replacement_value_used ?? null,
      surplus_basis: ve?.surplus_basis ?? null,
      auction_value: v?.auction_value ?? null,
      in_draftable_pool: v ? draftable.has(v.player_id) : false,
      valuation_row: Boolean(v),
    };
  });
  const ge48 =
    data.valuations?.filter(
      (v) =>
        draftable.has(v.player_id) &&
        typeof v.auction_value === "number" &&
        v.auction_value >= 47.5 &&
        v.auction_value <= 48.5,
    ).length ?? 0;
  const report = {
    generated_at: new Date().toISOString(),
    health,
    response_meta: {
      inflation_model: data.inflation_model ?? null,
      auction_curve_model: data.auction_curve_model ?? null,
      valuation_model_version: data.valuation_model_version ?? null,
    },
    acceptance: {
      util_replacement: repl.UTIL ?? repl.Util ?? null,
      draftable_pool_size: data.draftable_player_ids?.length ?? 0,
      plateau_at_48: ge48,
    },
    players,
  };
  const out = process.argv[2] ?? "/tmp/production-engine-smoke.json";
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
