import type { DraftedPlayer, LeanPlayer } from "../types/brain";
import { getPlayerId } from "./playerId";

export type PositionOverrideMap = Map<string, string[]>;

export const SLOT_SPECIFICITY_ORDER: readonly string[] = [
  "C",
  "SS",
  "2B",
  "3B",
  "1B",
  "CI",
  "MI",
  "OF",
  "SP",
  "RP",
  "P",
  "DH",
  "UTIL",
  "BN",
];

const HITTER_PRIMARIES = new Set([
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "OF",
  "DH",
  "CI",
  "MI",
]);

function normalizePositionToken(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (t === "LF" || t === "CF" || t === "RF") return "OF";
  return t;
}

export function tokenizeFantasyPositions(
  primary: string,
  extra?: readonly string[] | undefined
): string[] {
  const parts = [primary, ...(extra ?? [])].join(",").split(/[,/|]/);
  const out = new Set<string>();
  for (const p of parts) {
    const t = normalizePositionToken(p);
    if (t === "TWP") {
      out.add("DH");
      out.add("SP");
    } else if (t.length > 0) {
      out.add(t);
    }
  }
  return [...out];
}

/**
 * SP/RP inference when catalog lists generic "P" (requires pitching projection).
 */
function expandPitcherTokensFromProjection(p: LeanPlayer, base: string[]): string[] {
  const out = [...base];
  if (out.includes("P") && !out.includes("SP") && !out.includes("RP")) {
    const pitching = (p.projection as Record<string, unknown> | undefined)
      ?.pitching as Record<string, unknown> | undefined;
    const asNum = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "string") return Number(v);
      return NaN;
    };
    const saves = asNum(pitching?.saves);
    const starts = asNum(
      pitching?.games_started ??
        pitching?.gamesStarted ??
        pitching?.starts ??
        pitching?.gs
    );
    const innings = asNum(
      pitching?.innings_pitched ?? pitching?.inningsPitched ?? pitching?.ip
    );
    const rpLike = Number.isFinite(saves) && saves >= 10;
    const spLike =
      (Number.isFinite(starts) && starts >= 8) ||
      (Number.isFinite(innings) && innings >= 80);
    const hybridLike =
      Number.isFinite(saves) &&
      Number.isFinite(starts) &&
      saves >= 4 &&
      starts >= 4;
    if (hybridLike) {
      out.push("SP", "RP");
    } else if (rpLike && !spLike) {
      out.push("RP");
    } else {
      out.push("SP");
    }
  }
  return [...new Set(out)];
}

/**
 * Canonical fantasy tokens for a catalog player, optionally overridden per request
 * (`position_overrides` from Draftroom after min-games rules).
 */
export function effectiveFantasyTokens(
  p: LeanPlayer,
  overrides?: PositionOverrideMap | undefined
): string[] {
  const id = getPlayerId(p);
  const ov = overrides?.get(id);
  if (ov && ov.length > 0) {
    const primary = ov[0] ?? "";
    const extras = ov.slice(1);
    const base = tokenizeFantasyPositions(primary, extras);
    return expandPitcherTokensFromProjection(p, base);
  }
  const base = tokenizeFantasyPositions(p.position, p.positions);
  return expandPitcherTokensFromProjection(p, base);
}

export function playerTokensFromLean(
  p: LeanPlayer,
  overrides?: PositionOverrideMap | undefined
): string[] {
  return effectiveFantasyTokens(p, overrides);
}

/**
 * Draft rows carry no pitching projection — tokens match explicit strings only.
 * Overrides replace Mongo/draft positions entirely when present.
 */
export function playerTokensFromDrafted(
  dp: DraftedPlayer,
  overrides?: PositionOverrideMap | undefined
): string[] {
  const ov = overrides?.get(dp.player_id);
  if (ov && ov.length > 0) {
    return [...new Set(tokenizeFantasyPositions(ov[0]!, ov.slice(1)))];
  }
  return tokenizeFantasyPositions(dp.position, dp.positions);
}

/** Build override map from normalized valuation request payload. */
export function positionOverridesFromRequest(
  entries?: ReadonlyArray<{ player_id: string; positions: readonly string[] }> | null
): PositionOverrideMap | undefined {
  if (!entries || entries.length === 0) return undefined;
  const m = new Map<string, string[]>();
  for (const e of entries) {
    const id = typeof e.player_id === "string" ? e.player_id.trim() : "";
    if (!id) continue;
    const arr = Array.isArray(e.positions)
      ? e.positions.map((x) => String(x).trim()).filter((s) => s.length > 0)
      : [];
    if (arr.length === 0) continue;
    m.set(id, arr);
  }
  return m.size > 0 ? m : undefined;
}

export function isHitter(tokens: readonly string[]): boolean {
  for (const t of tokens) {
    if (HITTER_PRIMARIES.has(t)) return true;
  }
  return false;
}

export function isPurePitcher(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  for (const t of tokens) {
    if (t !== "SP" && t !== "RP" && t !== "P") return false;
  }
  return true;
}

export function fitsRosterSlot(slotKey: string, tokens: readonly string[]): boolean {
  const slot = slotKey.toUpperCase().trim();
  if (slot.length === 0) return false;
  if (slot === "BN") return true;
  if (slot === "UTIL") return isHitter(tokens);
  if (slot === "CI") return tokens.includes("1B") || tokens.includes("3B");
  if (slot === "MI") return tokens.includes("2B") || tokens.includes("SS");
  if (slot === "P") return tokens.includes("SP") || tokens.includes("RP") || tokens.includes("P");
  if (slot === "SP") return tokens.includes("SP") || tokens.includes("P");
  if (slot === "RP") return tokens.includes("RP") || tokens.includes("P");
  return tokens.includes(slot);
}

export function slotSpecificityIndex(
  slotKey: string,
  rosterSlotKeys: ReadonlySet<string>
): number {
  const u = slotKey.toUpperCase();
  const idx = SLOT_SPECIFICITY_ORDER.indexOf(u);
  if (idx !== -1) return idx;
  if (rosterSlotKeys.has(u)) return SLOT_SPECIFICITY_ORDER.length + u.charCodeAt(0);
  return 900 + u.charCodeAt(0);
}
