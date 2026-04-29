/**
 * Replay draft checkpoints like `replay-per-pick-draft.ts`: **`pre_draft`** budgets +
 * **terminal** `after_pick_N.json` supplies every `paid` / `pick_number`; we rewind
 * `drafted_players` before each pick and run valuation.
 *
 * **Catalog (pick one):**
 * - Default **proxy** pool from fixture names/positions + synthetic list $ (no Mongo;
 *   same spirit as `replay-2026-v2-validation.ts --proxy-only`).
 * - **`--mongo`**: load Mongo + **merge** every fixture `player_id` (drafted + keepers +
 *   minors/taxi) so picks resolve like `replay-2026-v2-validation.ts` (stubs only when
 *   truly missing). Uses `MONGO_URI` from the environment (e.g. `.env` via `dotenv`).
 *
 * **Defaults** align with `replay-per-pick-draft.ts`:
 *   `test-fixtures/player-api/checkpoints/after_pick_130.json` + `pre_draft.json`
 *
 * Run:
 *   pnpm replay-draft-json-analysis
 *   pnpm replay-draft-json-analysis:report
 *   pnpm exec ts-node --project tsconfig.scripts.json scripts/replay-draft-json-per-pick-analysis.ts -- --mongo --out ./analysis.json
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import type { DraftedPlayer, LeanPlayer } from "../src/types/brain";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import { PLAYER_CATALOG_LEAN_SELECT } from "../src/lib/playerCatalogProjection";
import {
  mergeMongoWithFixtureIdentities,
  type FixturePlayerMeta,
} from "../src/lib/replayMongoFixtureMerge";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import Player from "../src/models/Player";

const ROOT = path.resolve(__dirname, "..");

const DEFAULT_FULL = path.join(
  ROOT,
  "test-fixtures/player-api/checkpoints/after_pick_130.json"
);
const DEFAULT_PRE = path.join(
  ROOT,
  "test-fixtures/player-api/checkpoints/pre_draft.json"
);

function normPos(p: string): string {
  const u = p.toUpperCase().trim();
  if (u.includes("RP") && !u.includes("SP")) return "RP";
  if (u.includes("SP")) return "SP";
  if (u.startsWith("P") && u.length <= 2) return "SP";
  return u.split(/[,/]/)[0]?.trim() || "OF";
}

function buildProxyCatalog(
  fullPath: string,
  prePath: string,
  targetPoolSize = 920
): LeanPlayer[] {
  const full = JSON.parse(readFileSync(fullPath, "utf8")) as {
    drafted_players: DraftedPlayer[];
  };
  const pre = JSON.parse(readFileSync(prePath, "utf8")) as {
    pre_draft_rosters?: unknown;
  };
  const byId = new Map<string, LeanPlayer>();
  const add = (id: string, name: string, position: string, pick: number) => {
    const n = normPos(position);
    const value = Math.max(2, 220 - pick * 1.15);
    byId.set(id, {
      _id: `mlb_${id}`,
      mlbId: Number(id),
      name,
      team: "UNK",
      position: n,
      adp: pick,
      tier: pick <= 40 ? 1 : pick <= 90 ? 2 : 3,
      value: Math.round(value * 100) / 100,
    });
  };

  for (const dp of full.drafted_players ?? []) {
    const pick = dp.pick_number ?? 999;
    add(String(dp.player_id), dp.name, dp.position, pick);
  }

  const collectKeepers = (rows: DraftedPlayer[]) => {
    for (const p of rows) {
      if (!p.player_id || byId.has(String(p.player_id))) continue;
      const v = 38 + (String(p.player_id).length % 17);
      byId.set(String(p.player_id), {
        _id: `mlb_${p.player_id}`,
        mlbId: Number(p.player_id),
        name: p.name,
        team: p.team ?? "UNK",
        position: normPos(p.position),
        adp: 400 + byId.size,
        tier: 3,
        value: v,
      });
    }
  };

  const pr = pre.pre_draft_rosters;
  if (Array.isArray(pr)) {
    for (const b of pr) {
      if (typeof b !== "object" || b == null) continue;
      collectKeepers((b as { players?: DraftedPlayer[] }).players ?? []);
    }
  } else if (pr && typeof pr === "object") {
    for (const rows of Object.values(pr as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      collectKeepers(rows as DraftedPlayer[]);
    }
  }

  let filler = 0;
  const positions = ["OF", "OF", "SP", "RP", "C", "SS", "2B", "1B", "3B", "OF"];
  while (byId.size < targetPoolSize) {
    const id = 90000 + filler;
    const idStr = String(id);
    if (byId.has(idStr)) {
      filler++;
      continue;
    }
    const pos = positions[filler % positions.length];
    const v = Math.max(1.5, 28 - filler * 0.025);
    byId.set(idStr, {
      _id: `f_${idStr}`,
      mlbId: id,
      name: `Filler_${idStr}`,
      team: "NYY",
      position: pos,
      adp: 200 + filler,
      tier: 4,
      value: Math.round(v * 100) / 100,
    });
    filler++;
  }

  return [...byId.values()];
}

function sortDraftOrder(drafted: DraftedPlayer[]): DraftedPlayer[] {
  return [...drafted].sort((a, b) => {
    const pa = typeof a.pick_number === "number" ? a.pick_number : 999999;
    const pb = typeof b.pick_number === "number" ? b.pick_number : 999999;
    if (pa !== pb) return pa - pb;
    return String(a.player_id).localeCompare(String(b.player_id));
  });
}

function budgetAfterKeepers(preRaw: Record<string, unknown>): Record<string, number> {
  const m = preRaw.budget_by_team_id;
  if (!m || typeof m !== "object") {
    throw new Error("pre_draft JSON must include budget_by_team_id (post-keeper cash)");
  }
  return { ...(m as Record<string, number>) };
}

function subtractAuctionSpend(
  budgets: Record<string, number>,
  picks: DraftedPlayer[]
): void {
  for (const p of picks) {
    const tid = p.team_id;
    if (!tid || typeof tid !== "string") continue;
    const paid = p.paid;
    if (typeof paid !== "number" || !Number.isFinite(paid)) continue;
    budgets[tid] = (budgets[tid] ?? 0) - paid;
  }
}

function parseArgs(): {
  full: string;
  pre: string;
  maxPicks?: number;
  out?: string;
  useMongo: boolean;
} {
  const args = process.argv.slice(2);
  let full = DEFAULT_FULL;
  let pre = DEFAULT_PRE;
  let maxPicks: number | undefined;
  let out: string | undefined;
  let useMongo = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--full" && args[i + 1]) full = path.resolve(process.cwd(), args[++i]);
    else if (a === "--pre" && args[i + 1]) pre = path.resolve(process.cwd(), args[++i]);
    else if (a === "--max-picks" && args[i + 1]) maxPicks = parseInt(args[++i], 10);
    else if (a === "--out" && args[i + 1]) out = path.resolve(process.cwd(), args[++i]);
    else if (a === "--mongo") useMongo = true;
  }
  return { full, pre, maxPicks, out, useMongo };
}

async function loadMongoCatalog(): Promise<LeanPlayer[]> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is required for --mongo");
  await mongoose.connect(uri);
  try {
    const docs = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean().exec();
    return normalizeCatalogPlayers(docs, () => undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

function collectFixturePlayerMap(
  template: Record<string, unknown>,
  preRaw: Record<string, unknown>
): Map<string, FixturePlayerMeta> {
  const m = new Map<string, FixturePlayerMeta>();
  const add = (p: DraftedPlayer) => {
    if (!p?.player_id) return;
    const id = String(p.player_id);
    if (!m.has(id)) {
      m.set(id, {
        name: p.name ?? "",
        position: p.position ?? "OF",
        team: p.team ?? "",
      });
    }
  };

  const walkPreDraft = (raw: Record<string, unknown>) => {
    const pr = raw.pre_draft_rosters;
    if (Array.isArray(pr)) {
      for (const b of pr) {
        if (typeof b !== "object" || b == null) continue;
        for (const p of (b as { players?: DraftedPlayer[] }).players ?? []) add(p);
      }
    } else if (pr && typeof pr === "object") {
      for (const rows of Object.values(pr as Record<string, unknown>)) {
        if (!Array.isArray(rows)) continue;
        for (const p of rows as DraftedPlayer[]) add(p);
      }
    }
  };

  const walkBuckets = (buckets: unknown) => {
    if (!buckets) return;
    if (Array.isArray(buckets)) {
      for (const b of buckets) {
        if (typeof b !== "object" || b == null) continue;
        for (const p of (b as { players?: DraftedPlayer[] }).players ?? []) add(p);
      }
      return;
    }
    if (typeof buckets === "object") {
      for (const v of Object.values(buckets as Record<string, unknown>)) {
        if (!Array.isArray(v)) continue;
        for (const p of v as DraftedPlayer[]) add(p);
      }
    }
  };

  const drafted = template.drafted_players as DraftedPlayer[] | undefined;
  if (Array.isArray(drafted)) for (const p of drafted) add(p);
  walkPreDraft(template);
  walkPreDraft(preRaw);
  walkBuckets(template.minors);
  walkBuckets(template.taxi);
  walkBuckets(preRaw.minors);
  walkBuckets(preRaw.taxi);

  const auction = template.drafted_players as DraftedPlayer[] | undefined;
  if (Array.isArray(auction)) {
    for (const p of auction) {
      if (!p?.player_id) continue;
      const row = m.get(String(p.player_id));
      if (!row) continue;
      const pick = typeof p.pick_number === "number" ? p.pick_number : 200;
      row.list_value_hint =
        Math.round(Math.max(6, Math.min(92, 97 - pick * 0.46)) * 100) / 100;
    }
  }
  return m;
}

async function resolveCatalog(
  useMongo: boolean,
  fullPath: string,
  prePath: string,
  template: Record<string, unknown>,
  preRaw: Record<string, unknown>
): Promise<{ pool: LeanPlayer[]; merge_warnings?: string[] }> {
  if (!useMongo) {
    return { pool: buildProxyCatalog(fullPath, prePath) };
  }
  const mongo = await loadMongoCatalog();
  const fixtureMap = collectFixturePlayerMap(template, preRaw);
  const { pool, warnings } = mergeMongoWithFixtureIdentities(mongo, fixtureMap);
  return { pool, merge_warnings: warnings };
}

type TeamTav = { team_adjusted_value: number; edge: number };

async function main(): Promise<void> {
  const { full, pre, maxPicks, out: outPath, useMongo } = parseArgs();
  const template = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
  const preRaw = JSON.parse(readFileSync(pre, "utf8")) as Record<string, unknown>;
  const drafted = template.drafted_players as DraftedPlayer[] | undefined;
  if (!Array.isArray(drafted) || drafted.length === 0) {
    throw new Error(`No drafted_players in ${full}`);
  }
  const sorted = sortDraftOrder(drafted);
  const keeperBudgets = budgetAfterKeepers(preRaw);
  const teamIds = [
    ...new Set([
      ...Object.keys(keeperBudgets),
      ...sorted.map((d) => (typeof d.team_id === "string" ? d.team_id : "")).filter(Boolean),
    ]),
  ].sort();
  const catalogMode = useMongo ? "mongo" : "proxy";
  const { pool, merge_warnings } = await resolveCatalog(
    useMongo,
    full,
    pre,
    template,
    preRaw
  );

  const limit = Math.min(sorted.length, maxPicks ?? sorted.length);
  const perPick: unknown[] = [];
  const skips = { parse_failed: 0, workflow_failed: 0, missing_row: 0 };
  const absErrRec: number[] = [];
  const absErrAdj: number[] = [];
  const absErrTavClock: number[] = [];

  const byTeamClock: Record<
    string,
    { picks_on_clock: number; sum_abs_rec: number; sum_abs_tav: number }
  > = {};
  for (const t of teamIds) {
    byTeamClock[t] = { picks_on_clock: 0, sum_abs_rec: 0, sum_abs_tav: 0 };
  }

  for (let i = 0; i < limit; i++) {
    const prior = sorted.slice(0, i);
    const pick = sorted[i]!;
    const paid = pick.paid ?? NaN;
    if (!Number.isFinite(paid)) continue;

    const budgets = { ...keeperBudgets };
    subtractAuctionSpend(budgets, prior);

    const clockTeam =
      typeof pick.team_id === "string" && pick.team_id.length > 0
        ? pick.team_id
        : "team_1";

    const basePayload: Record<string, unknown> = {
      ...template,
      drafted_players: prior,
      budget_by_team_id: budgets,
      checkpoint: `replay_before_pick_${pick.pick_number ?? i + 1}`,
      deterministic: true,
      seed: 42,
      inflation_model: template.inflation_model ?? "replacement_slots_v2",
    };

    const teamTav: Record<string, TeamTav> = {};
    let leagueBlock: Record<string, unknown> | null = null;
    let focal:
      | {
          baseline_value: number;
          adjusted_value: number;
          recommended_bid: number;
          indicator: string;
        }
      | null = null;

    for (const tid of teamIds) {
      const raw = { ...basePayload, user_team_id: tid };
      const parsed = parseValuationRequest(raw as Record<string, unknown>);
      if (!parsed.success) {
        skips.parse_failed++;
        leagueBlock = null;
        break;
      }
      const out = executeValuationWorkflow(pool, parsed.normalized, {});
      if (!out.ok) {
        skips.workflow_failed++;
        leagueBlock = null;
        break;
      }
      const res = out.response;
      const row = res.valuations.find((r) => r.player_id === String(pick.player_id));
      if (!row) {
        skips.missing_row++;
        leagueBlock = null;
        break;
      }
      if (leagueBlock == null) {
        const ms = res.context_v2?.market_summary;
        leagueBlock = {
          inflation_factor: res.inflation_factor,
          inflation_index_vs_opening_auction:
            res.inflation_index_vs_opening_auction ?? null,
          inflation_percent_vs_auction_open:
            res.inflation_percent_vs_auction_open ?? null,
          inflation_percent_vs_neutral:
            ms?.inflation_percent_vs_neutral ??
            Math.round((res.inflation_factor - 1) * 100),
          phase_indicator: res.phase_indicator ?? null,
          headline: res.market_notes?.[0] ?? null,
          total_budget_remaining: res.total_budget_remaining,
          players_remaining: res.players_remaining,
        };
      }
      const rb = row.recommended_bid ?? row.adjusted_value;
      const tav = row.team_adjusted_value ?? row.adjusted_value;
      teamTav[tid] = {
        team_adjusted_value: tav,
        edge: row.edge ?? tav - rb,
      };

      if (tid === clockTeam) {
        focal = {
          baseline_value: row.baseline_value,
          adjusted_value: row.adjusted_value,
          recommended_bid: rb,
          indicator: row.indicator,
        };
      }
    }

    if (!leagueBlock || !focal) {
      perPick.push({
        pick_index: i + 1,
        pick_number: pick.pick_number ?? null,
        clock_team: clockTeam,
        player_id: pick.player_id,
        name: pick.name,
        error: "missing valuation row or parse/workflow failure",
      });
      continue;
    }

    const rec = focal.recommended_bid;
    const tavClock = teamTav[clockTeam]?.team_adjusted_value ?? focal.adjusted_value;
    absErrRec.push(Math.abs(paid - rec));
    absErrAdj.push(Math.abs(paid - focal.adjusted_value));
    absErrTavClock.push(Math.abs(paid - tavClock));

    const agg = byTeamClock[clockTeam];
    if (agg) {
      agg.picks_on_clock++;
      agg.sum_abs_rec += Math.abs(paid - rec);
      agg.sum_abs_tav += Math.abs(paid - tavClock);
    }

    const tavSpread =
      Math.max(...teamIds.map((t) => teamTav[t]!.team_adjusted_value)) -
      Math.min(...teamIds.map((t) => teamTav[t]!.team_adjusted_value));

    perPick.push({
      pick_index: i + 1,
      pick_number: pick.pick_number ?? null,
      clock_team: clockTeam,
      player_id: pick.player_id,
      name: pick.name,
      position: pick.position,
      paid,
      league: leagueBlock,
      focal_as_adjusted_pool: {
        baseline: focal.baseline_value,
        adjusted: focal.adjusted_value,
        recommended_bid: rec,
        team_adjusted_clock_team: tavClock,
        indicator: focal.indicator,
      },
      abs_error_vs_paid: {
        recommended_bid: Math.abs(paid - rec),
        adjusted_value: Math.abs(paid - focal.adjusted_value),
        team_adjusted_clock: Math.abs(paid - tavClock),
      },
      team_adjusted_value_by_team: Object.fromEntries(
        teamIds.map((t) => [t, teamTav[t]!.team_adjusted_value])
      ),
      team_adjusted_spread_across_teams: Number(tavSpread.toFixed(2)),
    });
  }

  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;

  const by_team_on_clock = Object.fromEntries(
    teamIds.map((t) => {
      const x = byTeamClock[t]!;
      const n = x.picks_on_clock;
      return [
        t,
        {
          picks_on_clock: n,
          mae_recommended_vs_paid: n ? x.sum_abs_rec / n : null,
          mae_team_adjusted_vs_paid: n ? x.sum_abs_tav / n : null,
        },
      ];
    })
  );

  const tavSpreads = (perPick as { team_adjusted_spread_across_teams?: number }[])
    .map((p) => p.team_adjusted_spread_across_teams)
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x));

  const scored = absErrRec.length;
  const picksFailed = limit - scored;
  const evaluation =
    catalogMode === "mongo"
      ? {
          how_useful: [
            "MAE vs `paid` (below) reflects **real** list $ from Mongo — use this run to judge recommended vs adjusted vs team_adjusted calibration.",
            "League inflation / index rows are comparable to production `POST /valuation/calculate` for the same checkpoint shape.",
            "`team_adjusted_spread_across_teams` still shows roster-lens dispersion for the focal player.",
          ],
          caveats: [
            "Ensure Mongo catalog matches the draft season the fixture used.",
            picksFailed > 0
              ? `${picksFailed} pick(s) had no focal row in valuations (catalog gap or parse failure); fix before trusting MAE.`
              : "All picks produced a focal valuation row.",
          ],
        }
      : {
          proxy_catalog_note:
            "Synthetic list $ from fixtures — MAE vs `paid` is **not** a quality signal; use for inflation trajectory + roster spread shape only.",
          how_useful: [
            "League-wide `inflation_factor` / `inflation_index_vs_opening_auction` track the same board state for every team before the pick; useful as a **shared temperature** gauge.",
            "`team_adjusted_value` differs by `user_team_id`; `team_adjusted_spread_across_teams` shows roster-lens dispersion for the focal player.",
            "Re-run with `--mongo` and `MONGO_URI` for meaningful `recommended_bid` vs `paid` error.",
          ],
          caveats: [
            "Run `pnpm replay-draft-json-analysis:report` (proxy) in CI; use `--mongo` locally/CI-with-secret for calibration.",
            "Keeper `is_keeper` flags in `drafted_players` affect opening-index replay; align fixtures with Draft.",
          ],
        };

  const report = {
    catalog_mode: catalogMode,
    ...(merge_warnings != null && merge_warnings.length > 0
      ? {
          catalog_merge_warning_count: merge_warnings.length,
          catalog_merge_warnings_sample: merge_warnings.slice(0, 25),
        }
      : {}),
    source_full: full,
    source_pre: pre,
    picks_in_fixture: sorted.length,
    picks_analyzed: limit,
    picks_scored_successfully: scored,
    picks_missing_catalog_or_failure: limit - scored,
    skips,
    summary_mae_vs_actual_paid: {
      recommended_bid_on_clock_team: mean(absErrRec),
      adjusted_value: mean(absErrAdj),
      team_adjusted_value_clock_team: mean(absErrTavClock),
    },
    mean_team_adjusted_spread_across_teams:
      tavSpreads.length > 0 ? mean(tavSpreads) : NaN,
    by_team_on_clock,
    per_pick: perPick,
    evaluation,
  };

  const text = JSON.stringify(report, null, 2);
  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, text, "utf8");
    console.error("Wrote", outPath);
  } else {
    console.log(text);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
