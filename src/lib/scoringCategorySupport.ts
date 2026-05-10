import type { ScoringCategory } from "../types/brain";

/**
 * Categories with explicit projection wiring in `categoryRawValue` /
 * `statFieldForCategory` (roto z-score path) and mirrored in points baselines.
 * `SO` is accepted as an alias for pitcher strikeouts (`K`).
 */
export const SUPPORTED_ROTO_BATTING = new Set([
  "R",
  "HR",
  "RBI",
  "SB",
  "AVG",
  "OBP",
  "SLG",
  "OPS",
  "TB",
]);

export const SUPPORTED_ROTO_PITCHING = new Set([
  "W",
  "SV",
  "K",
  "ERA",
  "WHIP",
  "QS",
  "HLD",
  "SV+HLD",
  "K/9",
]);

export function normalizeScoringCategoryName(name: string): string {
  const u = name.trim().toUpperCase();
  if (u === "SO") return "K";
  if (u === "K9") return "K/9";
  if (u === "SVHLD" || u === "SVHD") return "SV+HLD";
  if (u === "HOLD" || u === "HOLDS") return "HLD";
  return u;
}

export type UnsupportedScoringCategory = {
  name: string;
  type: string;
  normalized: string;
};

/**
 * Returns categories present in the request that are not implemented in v1
 * baseline math (ignored with zero contribution unless caught by strict mode).
 */
export function listUnsupportedScoringCategories(
  categories: ReadonlyArray<ScoringCategory>
): UnsupportedScoringCategory[] {
  const out: UnsupportedScoringCategory[] = [];
  for (const c of categories) {
    const t = (c.type ?? "").toLowerCase().trim();
    const normalized = normalizeScoringCategoryName(c.name);
    if (t === "batting") {
      if (!SUPPORTED_ROTO_BATTING.has(normalized)) {
        out.push({ name: c.name, type: c.type, normalized });
      }
    } else if (t === "pitching") {
      if (!SUPPORTED_ROTO_PITCHING.has(normalized)) {
        out.push({ name: c.name, type: c.type, normalized });
      }
    } else {
      out.push({ name: c.name, type: c.type, normalized });
    }
  }
  return out;
}

export function scoringCategorySupportWarnings(
  unsupported: ReadonlyArray<UnsupportedScoringCategory>
): string[] {
  return unsupported.map(
    (u) =>
      `Scoring category "${u.name}" (${u.type}) is not modeled in the valuation engine v1 projection pipeline; it is ignored (zero contribution). Supported batting: ${[...SUPPORTED_ROTO_BATTING].join(", ")}; pitching: ${[...SUPPORTED_ROTO_PITCHING].join(", ")} (SO aliases K).`
  );
}
