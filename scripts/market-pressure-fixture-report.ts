/**
 * Prints market_pressure fields for Draft checkpoint fixtures (mock catalog).
 * Run: npx tsx scripts/market-pressure-fixture-report.ts
 */
import { readFileSync } from "fs";
import { buildNormalizedFromNested } from "../src/lib/valuationRequestNormalization";
import { nestedValuationBodySchema } from "../src/lib/valuationRequestSchemas";
import {
  ENGINE_CHECKPOINT_IDS,
  draftCheckpointFixturesAvailable,
  resolveDraftCheckpointFixturePath,
} from "../src/lib/checkpointSlotReconciliation";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type { LeanPlayer } from "../src/types/brain";
import { buildDraftroomStandardValuationInput } from "../src/lib/calibrationDraftroomFixture";

function collectIds(body: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const add = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (r && typeof r === "object" && "player_id" in r) {
        const p = (r as { player_id?: unknown }).player_id;
        if (typeof p === "string" && p.length > 0) ids.add(p);
      }
    }
  };
  add(body.draft_state);
  const pdr = body.pre_draft_rosters;
  if (Array.isArray(pdr)) {
    for (const b of pdr) add((b as { players?: unknown }).players);
  } else if (pdr && typeof pdr === "object") {
    for (const rows of Object.values(pdr as Record<string, unknown>)) add(rows);
  }
  return ids;
}

function mockCatalog(ids: Iterable<string>): LeanPlayer[] {
  let i = 0;
  return [...ids].map((id) => {
    i += 1;
    const mlbId = Number(id);
    return {
      _id: `db_${id}`,
      ...(Number.isFinite(mlbId) ? { mlbId } : {}),
      name: `Player_${id}`,
      team: "NYY",
      position: i % 5 === 0 ? "SP" : "OF",
      catalog_rank: i,
      catalog_tier: (i % 5) + 1,
      value: Math.max(1, 95 - (i % 50)),
    };
  });
}

function run(input: ReturnType<typeof buildNormalizedFromNested>, catalog: LeanPlayer[]) {
  const out = executeValuationWorkflow(catalog, {
    ...input,
    deterministic: true,
    seed: 42,
    inflation_model: "replacement_slots_v2",
  });
  if (!out.ok) throw new Error(out.issues.join("; "));
  return out.response.context_v2?.market_pressure;
}

async function main() {
  if (!draftCheckpointFixturesAvailable()) {
    console.error("Draft checkpoints not found — clone AmethystDraft sibling.");
    process.exit(1);
  }

  const preRaw = JSON.parse(
    readFileSync(resolveDraftCheckpointFixturePath("pre_draft"), "utf8")
  ) as Record<string, unknown>;
  const preInput = buildNormalizedFromNested(nestedValuationBodySchema.parse(preRaw));

  const freshInput = buildDraftroomStandardValuationInput({
    num_teams: preInput.num_teams,
    total_budget: preInput.total_budget,
    roster_slots: preInput.roster_slots,
    scoring_categories: preInput.scoring_categories,
    league_scope: preInput.league_scope,
    scoring_format: preInput.scoring_format,
    drafted_players: [],
    pre_draft_rosters: undefined,
  });
  const freshCatalog = mockCatalog([]);

  const rows: Array<Record<string, string | number | null>> = [];

  const freshMp = run(freshInput, freshCatalog);
  rows.push(row("fresh no-keeper", freshMp));

  for (const id of ENGINE_CHECKPOINT_IDS) {
    const raw = JSON.parse(
      readFileSync(resolveDraftCheckpointFixturePath(id), "utf8")
    ) as Record<string, unknown>;
    const input = buildNormalizedFromNested(nestedValuationBodySchema.parse(raw));
    const mp = run(input, mockCatalog(collectIds(raw)));
    rows.push(row(id, mp));
  }

  console.log(
    "| checkpoint | inf.status | n | ratio | budget | cash/mass | $/slot | keeper | k cnt | fill | alloc vs open |",
  );
  console.log("|---|---|---:|---:|---|---:|---:|---|---:|---:|---:|");
  for (const r of rows) {
    console.log(
      `| ${r.checkpoint} | ${r.inf_status} | ${r.sample} | ${r.ratio} | ${r.budget_status} | ${r.cash_mass} | ${r.dps} | ${r.keeper_status} | ${r.k_cnt} | ${r.fill} | ${r.alloc} |`,
    );
  }
}

function row(
  checkpoint: string,
  mp: NonNullable<
    Awaited<ReturnType<typeof executeValuationWorkflow>> extends { ok: true; response: infer R }
      ? R
      : never
  >["context_v2"] extends { market_pressure?: infer M }
    ? M
    : never,
) {
  if (!mp) throw new Error(`missing market_pressure for ${checkpoint}`);
  return {
    checkpoint,
    inf_status: mp.market_inflation.status,
    sample: mp.market_inflation.sample_size,
    ratio: mp.market_inflation.ratio,
    budget_status: mp.budget_pressure.status,
    cash_mass: mp.budget_pressure.cash_to_surplus_mass_ratio,
    dps: mp.budget_pressure.dollars_per_open_slot,
    keeper_status: mp.keeper_compression.status,
    k_cnt: `${mp.keeper_compression.active_keeper_count}/${mp.keeper_compression.active_capacity}`,
    fill: mp.keeper_compression.keeper_slot_fill_ratio,
    alloc: mp.allocator_vs_open.ratio,
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
