import type { LeanPlayer } from "../types/brain";
import { playerTokensFromLean } from "../lib/fantasyRosterSlots";

export type ProjectionNode = Record<string, number | string | undefined>;
type CategoryDirection = "higher" | "lower";

export function toNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Uses full eligibility tokens (e.g. two-way SP+DH) so baseline matches slot/surplus logic. */
export function isPitcherForBaseline(p: LeanPlayer): boolean {
  return playerTokensFromLean(p).some((t) => t === "SP" || t === "RP" || t === "P");
}

export function getProjectionSection(
  p: LeanPlayer,
  section: "batting" | "pitching"
): ProjectionNode {
  const projection = p.projection as
    | Record<string, ProjectionNode | undefined>
    | undefined;
  return projection?.[section] ?? {};
}

export function categoryWeight(name: string): number {
  const key = name.toUpperCase();
  if (key === "AVG" || key === "OBP" || key === "ERA" || key === "WHIP") return 14;
  if (key === "HR" || key === "RBI" || key === "R" || key === "K") return 1;
  if (key === "SB" || key === "SV" || key === "W") return 1.6;
  if (key === "QS") return 1.2;
  return 0.8;
}

export function statFieldForCategory(name: string): string | null {
  const key = name.toUpperCase();
  if (key === "HR") return "hr";
  if (key === "RBI") return "rbi";
  if (key === "R") return "runs";
  if (key === "SB") return "sb";
  if (key === "AVG") return "avg";
  if (key === "OBP") return "obp";
  if (key === "K") return "strikeouts";
  if (key === "W") return "wins";
  if (key === "SV") return "saves";
  if (key === "ERA") return "era";
  if (key === "WHIP") return "whip";
  if (key === "QS") return "qualityStarts";
  return null;
}

export function categoryDirection(name: string): CategoryDirection {
  const key = name.toUpperCase();
  return key === "ERA" || key === "WHIP" ? "lower" : "higher";
}

export function categoryRawValue(section: ProjectionNode, name: string): number {
  const field = statFieldForCategory(name);
  if (!field) return 0;
  const raw = toNum(section[field as keyof ProjectionNode]);
  const key = name.toUpperCase();
  if (key === "AVG" || key === "OBP") return raw * 1000;
  return raw;
}

export function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

export function stdDev(vals: number[]): number {
  if (vals.length <= 1) return 0;
  const m = mean(vals);
  const variance =
    vals.reduce((s, v) => s + (v - m) * (v - m), 0) / (vals.length - 1);
  return Math.sqrt(Math.max(0, variance));
}
