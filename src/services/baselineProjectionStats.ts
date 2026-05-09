import type { LeanPlayer } from "../types/brain";
import {
  playerTokensFromLean,
  type PositionOverrideMap,
} from "../lib/fantasyRosterSlots";

export type ProjectionNode = Record<string, number | string | undefined>;
type CategoryDirection = "higher" | "lower";

export function toNum(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return fallback;
    const x = parseFloat(t);
    return Number.isFinite(x) ? x : fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Uses full eligibility tokens (e.g. two-way SP+DH) so baseline matches slot/surplus logic. */
export function isPitcherForBaseline(
  p: LeanPlayer,
  overrides?: PositionOverrideMap
): boolean {
  return playerTokensFromLean(p, overrides).some(
    (t) => t === "SP" || t === "RP" || t === "P"
  );
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

/** When AB/PA/IP are missing on older catalog rows, avoid rate-only blowups. */
const FALLBACK_ROTO_AB = 400;
const FALLBACK_ROTO_PA = 450;
const FALLBACK_ROTO_IP = 120;

function projectedAb(section: ProjectionNode): number {
  const ab = toNum(
    (section as Record<string, unknown>).atBats ?? (section as Record<string, unknown>).ab
  );
  if (ab > 0) return ab;
  return FALLBACK_ROTO_AB;
}

function projectedPa(section: ProjectionNode): number {
  const pa = toNum(
    (section as Record<string, unknown>).plateAppearances ??
      (section as Record<string, unknown>).pa
  );
  if (pa > 0) return pa;
  return Math.max(projectedAb(section) * 1.05, FALLBACK_ROTO_PA);
}

function projectedIpPitch(section: ProjectionNode): number {
  const v =
    (section as Record<string, unknown>).innings ??
    (section as Record<string, unknown>).inningsPitched ??
    (section as Record<string, unknown>).ip;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return FALLBACK_ROTO_IP;
}

/**
 * Raw scale for roto z-scores. Rate categories use volume-weighted “counting”
 * analogs (e.g. AVG×AB, ERA×IP) so part-time rate spikes do not dominate.
 */
export function categoryRawValue(section: ProjectionNode, name: string): number {
  const key = name.toUpperCase();
  if (key === "AVG") {
    return toNum(section.avg) * projectedAb(section);
  }
  if (key === "OBP") {
    return toNum(section.obp) * projectedPa(section);
  }
  if (key === "ERA") {
    return toNum(section.era) * projectedIpPitch(section);
  }
  if (key === "WHIP") {
    return toNum(section.whip) * projectedIpPitch(section);
  }
  const field = statFieldForCategory(name);
  if (!field) return 0;
  return toNum(section[field as keyof ProjectionNode]);
}

/**
 * Points leagues: use traditional stat lines (not AB/IP-weighted roto z inputs).
 */
export function pointsCategoryRaw(
  section: ProjectionNode,
  name: string
): number {
  const key = name.toUpperCase();
  const field = statFieldForCategory(name);
  if (key === "AVG" || key === "OBP") {
    return toNum(section[key === "AVG" ? "avg" : "obp"]);
  }
  if (field) return toNum(section[field as keyof ProjectionNode]);
  return 0;
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
