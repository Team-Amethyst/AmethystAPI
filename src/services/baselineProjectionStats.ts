import type { LeanPlayer } from "../types/brain";
import { normalizeScoringCategoryName } from "../lib/scoringCategorySupport";
import {
  isHitter,
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

/** Both hitter-eligible and pitcher-eligible fantasy tokens (single-row two-way). */
export function isTwoWayEligibleForBaseline(
  p: LeanPlayer,
  overrides?: PositionOverrideMap
): boolean {
  const tokens = playerTokensFromLean(p, overrides);
  return (
    isHitter(tokens) &&
    tokens.some((t) => t === "SP" || t === "RP" || t === "P")
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
  const key = normalizeScoringCategoryName(name);
  if (key === "AVG" || key === "OBP" || key === "SLG" || key === "OPS") return 14;
  /** Pitching rates (see categoryRawValue): modestly below AVG-class weights — pure ERA/WHIP rates without ×IP already lift ace SP z-mass vs legacy. */
  if (key === "ERA" || key === "WHIP") return 11;
  if (key === "HR" || key === "RBI" || key === "R" || key === "K" || key === "TB") return 1;
  if (key === "K/9") return 1;
  if (key === "SB" || key === "SV" || key === "W" || key === "HLD" || key === "SV+HLD") return 1.6;
  if (key === "QS") return 1.2;
  return 0.8;
}

export function statFieldForCategory(name: string): string | null {
  const key = normalizeScoringCategoryName(name);
  if (key === "HR") return "hr";
  if (key === "RBI") return "rbi";
  if (key === "R") return "runs";
  if (key === "SB") return "sb";
  if (key === "AVG") return "avg";
  if (key === "OBP") return "obp";
  if (key === "SLG") return "slg";
  if (key === "OPS") return "ops";
  if (key === "TB") return "totalBases";
  if (key === "HLD") return "holds";
  if (key === "K") return "strikeouts";
  if (key === "W") return "wins";
  if (key === "SV") return "saves";
  if (key === "ERA") return "era";
  if (key === "WHIP") return "whip";
  if (key === "QS") return "qualityStarts";
  return null;
}

export function categoryDirection(name: string): CategoryDirection {
  const key = normalizeScoringCategoryName(name);
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
 * Raw scale for roto z-scores.
 * - Batting rates use volume-weighted analogs (AVG×AB, OBP×PA, …) so part-time spikes don’t dominate.
 * - **Pitching ERA and WHIP use the rate only (not × IP)** for rotisserie z-scores. Multiplying rate×IP
 *   mixed SP and RP in one pool and punished high-IP starters (large raw) despite elite ratios.
 * - K/9 remains a per-inning rate (see branch below).
 */
export function categoryRawValue(section: ProjectionNode, name: string): number {
  const key = normalizeScoringCategoryName(name);
  if (key === "AVG") {
    return toNum(section.avg) * projectedAb(section);
  }
  if (key === "OBP") {
    return toNum(section.obp) * projectedPa(section);
  }
  if (key === "SLG") {
    return toNum(section.slg) * projectedAb(section);
  }
  if (key === "OPS") {
    return toNum(section.ops) * projectedPa(section);
  }
  if (key === "TB") {
    return toNum(section.totalBases);
  }
  if (key === "HLD") {
    return toNum(section.holds);
  }
  if (key === "SV+HLD") {
    return toNum(section.saves) + toNum(section.holds);
  }
  if (key === "K/9") {
    const ip = projectedIpPitch(section);
    const k = toNum(section.strikeouts);
    /** Per-player K/9 rate (9×K/IP); z-scored across pool — not multiplied by IP (volume already in K/IP). */
    return ip > 0 ? (9 * k) / ip : 0;
  }
  if (key === "ERA") {
    return toNum(section.era);
  }
  if (key === "WHIP") {
    return toNum(section.whip);
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
  const key = normalizeScoringCategoryName(name);
  const field = statFieldForCategory(name);
  if (key === "AVG" || key === "OBP") {
    return toNum(section[key === "AVG" ? "avg" : "obp"]);
  }
  if (key === "SLG") return toNum(section.slg);
  if (key === "OPS") return toNum(section.ops);
  if (key === "TB") return toNum(section.totalBases);
  if (key === "HLD") return toNum(section.holds);
  if (key === "SV+HLD") return toNum(section.saves) + toNum(section.holds);
  if (key === "K/9") {
    const ip = projectedIpPitch(section);
    const k = toNum(section.strikeouts);
    return ip > 0 ? (9 * k) / ip : 0;
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
