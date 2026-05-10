/**
 * Heuristic projection outlier detection — warn/quarantine only; does not modify projections.
 */

import type { LeanPlayer } from "../types/brain";

export type ProjectionSanityIssue = {
  player_id: string;
  name: string;
  position: string;
  reason: string;
  detail?: Record<string, unknown>;
};

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function batting(proj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!proj || typeof proj !== "object") return undefined;
  const b = (proj as { batting?: unknown }).batting;
  return b != null && typeof b === "object" ? (b as Record<string, unknown>) : undefined;
}

function pitching(proj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!proj || typeof proj !== "object") return undefined;
  const p = (proj as { pitching?: unknown }).pitching;
  return p != null && typeof p === "object" ? (p as Record<string, unknown>) : undefined;
}

function positionUpper(pos: string): string {
  return pos.trim().toUpperCase();
}

export function collectProjectionSanityIssues(
  players: LeanPlayer[],
  getId: (p: LeanPlayer) => string
): ProjectionSanityIssue[] {
  const issues: ProjectionSanityIssue[] = [];
  const byPosHR: Record<string, number[]> = {};
  for (const p of players) {
    const pos = positionUpper(p.position);
    const bat = batting(p.projection as Record<string, unknown> | undefined);
    const hr = bat ? num(bat.hr) : undefined;
    if (hr != null) {
      if (!byPosHR[pos]) byPosHR[pos] = [];
      byPosHR[pos]!.push(hr);
    }
  }
  const posMedHR = (pos: string): number => {
    const arr = (byPosHR[pos] ?? []).filter((x) => x >= 0).sort((a, b) => a - b);
    if (arr.length === 0) return 20;
    return arr[Math.floor(arr.length / 2)] ?? 20;
  };

  for (const p of players) {
    const id = getId(p);
    const pos = positionUpper(p.position);
    const proj = p.projection as Record<string, unknown> | undefined;
    const bat = batting(proj);
    const pit = pitching(proj);
    const hr = bat ? num(bat.hr) : undefined;
    const rbi = bat ? num(bat.rbi) : undefined;
    const runs = bat ? num(bat.runs) : undefined;
    const sb = bat ? num(bat.sb) : undefined;
    const obpS = bat ? (bat.obp as string | number | undefined) : undefined;
    const med = posMedHR(pos);

    if (pos === "C" && hr != null && hr >= 40) {
      issues.push({
        player_id: id,
        name: p.name,
        position: p.position,
        reason: "CATCHER_HR_EXTREME",
        detail: { hr, threshold: 40 },
      });
    }
    if (hr != null && med > 0 && hr - med > 2.5 * Math.max(8, med * 0.5)) {
      issues.push({
        player_id: id,
        name: p.name,
        position: p.position,
        reason: "HITTER_HR_POSITION_OUTLIER",
        detail: { hr, position_median_hr: med },
      });
    }
    if (hr != null && rbi != null && runs != null && sb != null) {
      if (hr >= 50 && sb >= 12) {
        issues.push({
          player_id: id,
          name: p.name,
          position: p.position,
          reason: "IMPLAUSIBLE_POWER_AND_SPEED",
          detail: { hr, sb },
        });
      }
    }
    if (pos === "C" && rbi != null && rbi >= 120) {
      issues.push({
        player_id: id,
        name: p.name,
        position: p.position,
        reason: "CATCHER_RBI_EXTREME",
        detail: { rbi },
      });
    }
    if (pos === "C" && runs != null && runs >= 100) {
      issues.push({
        player_id: id,
        name: p.name,
        position: p.position,
        reason: "CATCHER_RUNS_EXTREME",
        detail: { runs },
      });
    }
    const pitcherPrimary = pos === "P" || pos === "SP" || pos === "RP";
    if (
      bat &&
      obpS === undefined &&
      (p.catalog_tier ?? 99) <= 6 &&
      (p.value ?? 0) >= 8 &&
      !pitcherPrimary
    ) {
      issues.push({
        player_id: id,
        name: p.name,
        position: p.position,
        reason: "BATTING_OBP_MISSING",
        detail: { note: "Helpful for OBP leagues" },
      });
    }
    if (pit) {
      const era = num(pit.era);
      const ip = pit.innings;
      const ipN = ip != null ? num(ip) : undefined;
      if (era != null && era < 0.5 && (ipN == null || ipN > 20)) {
        issues.push({
          player_id: id,
          name: p.name,
          position: p.position,
          reason: "PITCHING_ERA_IMPLAUSIBLY_LOW",
          detail: { era, innings: ip },
        });
      }
    }
  }
  return issues;
}
