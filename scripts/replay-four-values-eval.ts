/**
 * Replay checkpoints and score all 4 valuation dollars vs realized paid.
 *
 * Uses prior-step predictions for players newly drafted in the next step:
 * - baseline_value
 * - adjusted_value
 * - recommended_bid
 * - team_adjusted_value
 *
 * Requires MONGO_URI (loads real catalog).
 * Run: pnpm exec ts-node --project tsconfig.scripts.json scripts/replay-four-values-eval.ts
 */
import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import mongoose from "mongoose";
import Player from "../src/models/Player";
import { PLAYER_CATALOG_LEAN_SELECT } from "../src/lib/playerCatalogProjection";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import { parseValuationRequest } from "../src/lib/valuationRequest";
import { executeValuationWorkflow } from "../src/services/valuationWorkflow";
import type {
  DraftPhaseIndicator,
  DraftedPlayer,
  LeanPlayer,
  NormalizedValuationInput,
} from "../src/types/brain";

type Manifest = {
  steps: { label: string; request_path: string }[];
};

type MetricKey = "baseline" | "adjusted" | "recommended" | "team";

type Pred = {
  baseline: number;
  adjusted: number;
  recommended: number | null;
  team: number | null;
  position: string;
};

type Obs = {
  paid: number;
  phase: DraftPhaseIndicator | "unknown";
  position: string;
  byMetric: Record<MetricKey, number>;
};

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "test-fixtures/replay-evaluator/manifest.json");

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function collectAllRosterPlayerIds(n: NormalizedValuationInput): Set<string> {
  const ids = new Set<string>();
  for (const d of n.drafted_players) ids.add(d.player_id);
  const collectUnknownRows = (rows: unknown[] | undefined) => {
    for (const row of rows ?? []) {
      if (typeof row !== "object" || row == null) continue;
      const rec = row as Record<string, unknown>;
      const pid = rec.player_id;
      if (typeof pid === "string" && pid.length > 0) ids.add(pid);
    }
  };
  if (n.pre_draft_rosters) {
    for (const rows of Object.values(n.pre_draft_rosters)) {
      collectUnknownRows(Array.isArray(rows) ? rows : []);
    }
  }
  const collectBuckets = (buckets: NormalizedValuationInput["minors"]) => {
    if (!buckets) return;
    if (Array.isArray(buckets)) {
      for (const bucket of buckets) collectUnknownRows(bucket.players as unknown[]);
      return;
    }
    for (const v of Object.values(buckets)) {
      if (Array.isArray(v)) collectUnknownRows(v);
    }
  };
  collectBuckets(n.minors);
  collectBuckets(n.taxi);
  return ids;
}

function newAuctionPicks(
  prev: NormalizedValuationInput | null,
  curr: NormalizedValuationInput
): DraftedPlayer[] {
  if (!prev) return [];
  const prevKnown = collectAllRosterPlayerIds(prev);
  return curr.drafted_players.filter((d) => !prevKnown.has(d.player_id));
}

function posBucket(pos: string): string {
  const u = pos.toUpperCase();
  if (u.includes("SP")) return "SP";
  if (u.includes("RP")) return "RP";
  if (u.includes("P")) return "P";
  if (u.includes("C")) return "C";
  if (u.includes("SS")) return "SS";
  if (u.includes("2B")) return "2B";
  if (u.includes("3B")) return "3B";
  if (u.includes("1B")) return "1B";
  if (u.includes("OF")) return "OF";
  return "OTHER";
}

function printSlice(label: string, rows: Obs[]): void {
  const pick = (k: MetricKey) =>
    rows
      .map((r) => r.byMetric[k])
      .filter((v) => Number.isFinite(v));
  const b = pick("baseline");
  const a = pick("adjusted");
  const r = pick("recommended");
  const t = pick("team");
  console.log(`\n${label} (n=${rows.length})`);
  console.log(
    `  baseline_value      MAE=${mean(b).toFixed(3)} medianAE=${median(b).toFixed(3)}`
  );
  console.log(
    `  adjusted_value      MAE=${mean(a).toFixed(3)} medianAE=${median(a).toFixed(3)}`
  );
  console.log(
    `  recommended_bid     MAE=${mean(r).toFixed(3)} medianAE=${median(r).toFixed(3)}`
  );
  console.log(
    `  team_adjusted_value MAE=${mean(t).toFixed(3)} medianAE=${median(t).toFixed(3)}`
  );
}

async function loadMongoPool(): Promise<LeanPlayer[]> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing");
  await mongoose.connect(uri);
  try {
    const docs = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean().exec();
    return normalizeCatalogPlayers(docs, () => undefined);
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  const pool = await loadMongoPool();

  let prevNorm: NormalizedValuationInput | null = null;
  const prevPred = new Map<string, Pred>();
  let prevPhase: DraftPhaseIndicator | "unknown" = "unknown";
  const observations: Obs[] = [];

  for (const step of manifest.steps) {
    const reqPath = path.join(ROOT, step.request_path);
    const raw = JSON.parse(readFileSync(reqPath, "utf8")) as Record<string, unknown>;
    const parsed = parseValuationRequest({
      ...raw,
      inflation_model: raw.inflation_model ?? "replacement_slots_v2",
    });
    if (!parsed.success) continue;

    const n = parsed.normalized;
    const picks = newAuctionPicks(prevNorm, n);
    for (const p of picks) {
      const paid = p.paid ?? NaN;
      if (!Number.isFinite(paid)) continue;
      const pred = prevPred.get(p.player_id);
      if (!pred) continue;
      observations.push({
        paid,
        phase: prevPhase,
        position: posBucket(pred.position || p.position),
        byMetric: {
          baseline: Math.abs(paid - pred.baseline),
          adjusted: Math.abs(paid - pred.adjusted),
          recommended: Math.abs(paid - (pred.recommended ?? pred.adjusted)),
          team: Math.abs(paid - (pred.team ?? pred.adjusted)),
        },
      });
    }

    const out = executeValuationWorkflow(pool, n, {});
    if (!out.ok) {
      prevNorm = n;
      prevPred.clear();
      prevPhase = "unknown";
      continue;
    }
    prevNorm = n;
    prevPhase = out.response.phase_indicator ?? "unknown";
    prevPred.clear();
    for (const row of out.response.valuations) {
      prevPred.set(row.player_id, {
        baseline: row.baseline_value,
        adjusted: row.adjusted_value,
        recommended:
          typeof row.recommended_bid === "number" ? row.recommended_bid : null,
        team:
          typeof row.team_adjusted_value === "number"
            ? row.team_adjusted_value
            : null,
        position: row.position,
      });
    }
  }

  console.log("=== Four-value replay evaluation (paid vs prior-step predictions) ===");
  console.log(`observations: ${observations.length}`);
  printSlice("Overall", observations);

  for (const ph of ["early", "mid", "late", "unknown"] as const) {
    const rows = observations.filter((o) => o.phase === ph);
    if (rows.length >= 8) printSlice(`By phase: ${ph}`, rows);
  }

  const buckets = ["OF", "1B", "2B", "3B", "SS", "C", "SP", "RP", "P", "OTHER"];
  for (const b of buckets) {
    const rows = observations.filter((o) => o.position === b);
    if (rows.length >= 8) printSlice(`By position: ${b}`, rows);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

