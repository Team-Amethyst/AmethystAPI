import { playerTokensFromLean } from "../fantasyRosterSlots";
import { getPlayerId } from "../playerId";
import type { LeanPlayer, NormalizedValuationInput } from "../../types/brain";
import type { ValuedPlayer, ValuationResponse } from "../../types/valuation";
export type V2AuditMaps = {
  playerIdToHybridLift?: Map<string, number>;
  playerIdToSlotOnlySurplusBasis?: Map<string, number>;
  playerIdToAssignedSlot?: Map<string, string>;
  playerIdToMarginalReplacement?: Map<string, number>;
};

export const ENGINE_CHECKPOINTS = [
  "pre_draft",
  "after_pick_10",
  "after_pick_50",
  "after_pick_100",
  "after_pick_130",
  "finished_league",
] as const;

export type AuditCheckpointId = (typeof ENGINE_CHECKPOINTS)[number];

export function normName(n: string): string {
  return n
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function buildCatalogEnvelope(
  input: NormalizedValuationInput,
  pool: LeanPlayer[],
): NormalizedValuationInput {
  const drafted = new Set(
    [
      ...input.drafted_players.map((d: { player_id: string }) => d.player_id),
      ...(input.pre_draft_rosters
        ? Object.values(input.pre_draft_rosters).flatMap((rows) =>
            (rows as { player_id?: string }[]).map((r) => String(r.player_id ?? "")),
          )
        : []),
    ].filter(Boolean),
  );
  const position_overrides: { player_id: string; positions: string[] }[] = [];
  const injury_overrides: { player_id: string; injury_severity: number }[] = [];
  const player_ids: string[] = [];
  for (const p of pool) {
    const id = getPlayerId(p);
    const tok = playerTokensFromLean(p, undefined);
    if (tok.length > 0) {
      position_overrides.push({ player_id: id, positions: tok });
    }
    const sev = p.injurySeverity;
    if (typeof sev === "number" && sev >= 0 && sev <= 3) {
      injury_overrides.push({ player_id: id, injury_severity: sev });
    }
    if (!drafted.has(id)) player_ids.push(id);
  }
  return {
    ...input,
    player_ids,
    position_overrides,
    injury_overrides,
    deterministic: true,
    seed: 42,
    inflation_model: "replacement_slots_v2",
    auction_curve_model: "adaptive_surplus_v1",
    explain_valuation_rows: true,
  };
}

export function workflowBody(
  input: NormalizedValuationInput,
): NormalizedValuationInput {
  return {
    ...input,
    deterministic: true,
    seed: 42,
    inflation_model: "replacement_slots_v2",
    auction_curve_model: "adaptive_surplus_v1",
    explain_valuation_rows: true,
  };
}

export function bucketThresholds(vals: number[]) {
  return {
    ge40: vals.filter((v) => v >= 40).length,
    ge30: vals.filter((v) => v >= 30).length,
    ge20: vals.filter((v) => v >= 20).length,
    ge15: vals.filter((v) => v >= 15).length,
    ge10: vals.filter((v) => v >= 10).length,
    ge5: vals.filter((v) => v >= 5).length,
    ge1: vals.filter((v) => v > 1.05).length,
    minBid: vals.filter((v) => v <= 1.05).length,
    noValue: vals.filter((v) => v < 0.01).length,
  };
}

export function shelfCount(vals: number[], target: number, tol = 0.5): number {
  return vals.filter((v) => v >= target - tol && v <= target + tol).length;
}

export function largestAdjacentDrop(
  sorted: { auction_value: number }[],
  limit: number,
): { drop: number; fromRank: number; toRank: number } {
  let maxDrop = 0;
  let fromRank = 0;
  let toRank = 0;
  const n = Math.min(limit, sorted.length - 1);
  for (let i = 0; i < n; i++) {
    const d = sorted[i]!.auction_value - sorted[i + 1]!.auction_value;
    if (d > maxDrop) {
      maxDrop = d;
      fromRank = i + 1;
      toRank = i + 2;
    }
  }
  return { drop: maxDrop, fromRank, toRank };
}

export function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function displayDollar(av: number): number {
  return Math.round(av);
}

export function draftableRows(
  r: ValuationResponse,
): ValuedPlayer[] {
  const ids = new Set(r.draftable_player_ids ?? []);
  return r.valuations.filter((v: ValuedPlayer) => ids.has(v.player_id));
}

export function findPlayerRow(
  rows: ValuedPlayer[],
  name: string,
): ValuedPlayer | undefined {
  const want = normName(name);
  return rows.find((r) => normName(r.name ?? "") === want);
}

export function primaryPositionGroup(
  slot: string | undefined,
  position: string | undefined,
): string {
  const s = (slot ?? position ?? "UTIL").toUpperCase();
  if (["C", "1B", "2B", "3B", "SS", "MI", "CI", "OF", "UTIL"].includes(s)) return s;
  if (s.includes("SP")) return "SP";
  if (s.includes("RP") || s === "P") return "RP";
  return s;
}

export function hybridDiagnostics(
  v2: V2AuditMaps,
  playerId: string,
): {
  hybrid_lift: number | null;
  slot_only_surplus: number | null;
  assigned_slot: string | null;
  marginal_replacement: number | null;
} {
  const lift = v2.playerIdToHybridLift?.get(playerId) ?? 0;
  return {
    hybrid_lift: lift > 0 ? lift : null,
    slot_only_surplus: v2.playerIdToSlotOnlySurplusBasis?.get(playerId) ?? null,
    assigned_slot: v2.playerIdToAssignedSlot?.get(playerId) ?? null,
    marginal_replacement: v2.playerIdToMarginalReplacement?.get(playerId) ?? null,
  };
}

export function flagBoardShape(metrics: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const plateau48 = Number(metrics.plateau_at_48 ?? 0);
  const shelf32 = Number(metrics.shelf_at_32 ?? 0);
  const shelf15 = Number(metrics.shelf_at_15 ?? 0);
  const drop25 = Number(metrics.largest_drop_top25 ?? 0);
  const drop75 = Number(metrics.largest_drop_top75 ?? 0);
  const endgame20 = Number(metrics.endgame_above_20 ?? 0);
  const top1 = Number(metrics.max_auction ?? 0);
  const top25avg = Number(metrics.top25_avg ?? 0);

  if (plateau48 >= 3) flags.push("plateau_at_$48");
  if (shelf32 >= 4) flags.push("shelf_at_$32");
  if (shelf15 >= 8) flags.push("shelf_at_$15");
  if (drop25 >= 12) flags.push("cliff_top25");
  if (drop75 >= 10) flags.push("cliff_top75");
  if (endgame20 >= 12) flags.push("endgame_inflation_above_$20");
  if (top1 > 0 && top25avg > 0 && top1 / top25avg < 1.35) flags.push("star_compression");
  if (top1 > 0 && top25avg > 0 && top1 - top25avg < 8) flags.push("flat_top_band");
  return flags;
}
