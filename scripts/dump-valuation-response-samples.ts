/**
 * Writes trimmed valuation API samples for documentation (no Mongo).
 * Run: pnpm exec ts-node --project tsconfig.scripts.json scripts/dump-valuation-response-samples.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { LeanPlayer } from "../src/types/brain";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "test-fixtures", "valuation-response-samples");
const POOL = 512;

function mockCatalog(): LeanPlayer[] {
  return Array.from({ length: POOL }, (_, i) => ({
    _id: `db_${i}`,
    mlbId: i + 1,
    name: `Player_${i + 1}`,
    team: "NYY",
    position: "OF",
    adp: i + 1,
    tier: (i % 5) + 1,
    value: Math.max(1, 90 - (i % 45)),
  }));
}

function summarize(res: ReturnType<typeof executeValuationWorkflow>) {
  if (!res.ok) return { ok: false as const, issues: res.issues };
  const { valuations, ...rest } = res.response;
  return {
    ok: true as const,
    response_summary: rest,
    sample_valuations: valuations.slice(0, 5),
  };
}

function main() {
  const catalog = mockCatalog();
  mkdirSync(OUT, { recursive: true });
  const files = ["pre_draft.json", "after_pick_50.json", "after_pick_100.json"] as const;
  for (const f of files) {
    const raw = JSON.parse(
      readFileSync(
        path.join(ROOT, "test-fixtures", "player-api", "checkpoints", f),
        "utf8"
      )
    ) as Record<string, unknown>;
    const parsed = parseValuationRequest({
      ...raw,
      inflation_model: "replacement_slots_v2",
      deterministic: true,
      seed: 7,
    });
    if (!parsed.success) {
      throw new Error(`parse failed ${f}: ${JSON.stringify(parsed.errors)}`);
    }
    const wf = executeValuationWorkflow(catalog, parsed.normalized, {});
    const out = { checkpoint: f.replace(".json", ""), ...summarize(wf) };
    writeFileSync(
      path.join(OUT, f.replace(".json", ".response.sample.json")),
      JSON.stringify(out, null, 2),
      "utf8"
    );
  }
  console.log("Wrote samples to", OUT);
}

main();
