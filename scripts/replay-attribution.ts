/**
 * Replay attribution report for largest paid-vs-prediction misses.
 * Includes debug_v2 diagnostics emitted by executeValuationWorkflow(debugSignals=true).
 *
 * Requires MONGO_URI.
 * Run: pnpm exec ts-node --project tsconfig.scripts.json scripts/replay-attribution.ts
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
import type { DraftedPlayer, NormalizedValuationInput, ValuedPlayer } from "../src/types/brain";

type Manifest = { steps: { label: string; request_path: string }[] };
type Pred = {
  adjusted: number;
  recommended: number | null;
  team: number | null;
  baseline: number;
  debug?: ValuedPlayer["debug_v2"];
};

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "test-fixtures/replay-evaluator/manifest.json");

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

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  await mongoose.connect(process.env.MONGO_URI);
  const docs = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean().exec();
  const pool = normalizeCatalogPlayers(docs, () => undefined);
  await mongoose.disconnect().catch(() => undefined);

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  let prevNorm: NormalizedValuationInput | null = null;
  const prevPred = new Map<string, Pred>();

  const misses: Array<Record<string, unknown>> = [];

  for (const step of manifest.steps) {
    const raw = JSON.parse(
      readFileSync(path.join(ROOT, step.request_path), "utf8")
    ) as Record<string, unknown>;
    const parsed = parseValuationRequest({
      ...raw,
      inflation_model: raw.inflation_model ?? "replacement_slots_v2",
    });
    if (!parsed.success) continue;
    const n = parsed.normalized;

    for (const p of newAuctionPicks(prevNorm, n)) {
      const pred = prevPred.get(p.player_id);
      if (!pred) continue;
      const paid = p.paid ?? NaN;
      if (!Number.isFinite(paid)) continue;
      const rec = pred.recommended ?? pred.adjusted;
      const team = pred.team ?? pred.adjusted;
      const absRec = Math.abs(paid - rec);
      if (absRec < 12) continue;
      misses.push({
        checkpoint: step.label,
        pick: p.pick_number ?? null,
        player_id: p.player_id,
        name: p.name,
        position: p.position,
        paid,
        baseline_value: Number(pred.baseline.toFixed(2)),
        adjusted_value: Number(pred.adjusted.toFixed(2)),
        recommended_bid: Number(rec.toFixed(2)),
        team_adjusted_value: Number(team.toFixed(2)),
        delta_paid_recommended: Number((paid - rec).toFixed(2)),
        delta_paid_adjusted: Number((paid - pred.adjusted).toFixed(2)),
        delta_paid_team: Number((paid - team).toFixed(2)),
        debug: pred.debug ?? null,
      });
    }

    const out = executeValuationWorkflow(pool, n, {}, { debugSignals: true });
    prevNorm = n;
    prevPred.clear();
    if (!out.ok) continue;
    for (const row of out.response.valuations) {
      prevPred.set(row.player_id, {
        adjusted: row.adjusted_value,
        recommended: row.recommended_bid ?? null,
        team: row.team_adjusted_value ?? null,
        baseline: row.baseline_value,
        debug: row.debug_v2,
      });
    }
  }

  misses.sort(
    (a, b) =>
      Math.abs(Number(b.delta_paid_recommended)) -
      Math.abs(Number(a.delta_paid_recommended))
  );
  console.log(
    JSON.stringify(
      {
        count: misses.length,
        top_20: misses.slice(0, 20),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

