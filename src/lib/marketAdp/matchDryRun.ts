import { normalizePlayerName, normalizeTeamAbbrev } from "../catalogIdentityHelpers";
import type { DryRunMatch, MarketAdpVendorRow, ProposedCatalogUpdate } from "./types";
import type { LeanPlayer } from "../../types/brain";
import { getPlayerId } from "../playerId";

type CatalogMatchKey = {
  mlb_id: number | null | undefined;
  normalized_name: string;
  team_upper: string;
  position_upper: string;
  player_id: string;
};

function normPos(p: string): string {
  return p.trim().toUpperCase();
}

function splitPosTokens(raw: string): string[] {
  return normPos(raw)
    .split(/[,/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function positionCompatible(catalogPos: string, vendorPos: string): boolean {
  const c = normPos(catalogPos);
  const v = normPos(vendorPos);
  if (c === v) return true;
  if (v === "P" && (c === "SP" || c === "RP")) return true;
  if (c === "P" && (v === "SP" || v === "RP")) return true;
  if (v === "DH" && c === "UTIL") return false;
  const cParts = splitPosTokens(catalogPos);
  const vParts = splitPosTokens(vendorPos);
  if (vParts.some((t) => cParts.includes(t))) return true;
  return false;
}

function keysFromLean(p: LeanPlayer): CatalogMatchKey {
  return {
    mlb_id: p.mlbId,
    normalized_name: normalizePlayerName(p.name),
    team_upper: normalizeTeamAbbrev(p.team),
    position_upper: normPos(p.position),
    player_id: getPlayerId(p),
  };
}

function keysFromVendor(v: MarketAdpVendorRow): Omit<CatalogMatchKey, "player_id"> {
  return {
    mlb_id: v.mlb_id,
    normalized_name: normalizePlayerName(v.name),
    team_upper: normalizeTeamAbbrev(v.team),
    position_upper: normPos(v.position),
  };
}

/**
 * Dry-run only: match vendor ADP rows to catalog players.
 * When `mlb_id` matches uniquely among unmatched rows, use it; else fall back to name+team+position (non-ambiguous only).
 */
export function dryRunMatchMarketAdp(
  catalog: LeanPlayer[],
  vendorRows: MarketAdpVendorRow[],
  sourceName: string,
  fetchedAt: string
): { matches: DryRunMatch[]; proposed_updates: ProposedCatalogUpdate[] } {
  const byMlbId = new Map<number, LeanPlayer[]>();
  const nameTeamPosIndex = new Map<string, LeanPlayer[]>();

  for (const p of catalog) {
    if (p.mlbId != null && Number.isFinite(p.mlbId) && p.mlbId > 0) {
      const arr = byMlbId.get(p.mlbId) ?? [];
      arr.push(p);
      byMlbId.set(p.mlbId, arr);
    }
    const vk = `${keysFromLean(p).normalized_name}|${keysFromLean(p).team_upper}|${keysFromLean(p).position_upper}`;
    const arr2 = nameTeamPosIndex.get(vk) ?? [];
    arr2.push(p);
    nameTeamPosIndex.set(vk, arr2);
  }

  const matches: DryRunMatch[] = [];
  const proposed_updates: ProposedCatalogUpdate[] = [];
  const matchedCatalogIds = new Set<string>();

  for (const v of vendorRows) {
    if (!Number.isFinite(v.adp) || v.adp <= 0) {
      matches.push({
        kind: "unmatched_vendor",
        vendor: v,
        reason: "invalid_adp",
      });
      continue;
    }
    const vk = keysFromVendor(v);
    let candidates: LeanPlayer[] = [];

    if (vk.mlb_id != null && Number.isFinite(vk.mlb_id) && vk.mlb_id > 0) {
      candidates = (byMlbId.get(vk.mlb_id) ?? []).filter(
        (p) => !matchedCatalogIds.has(getPlayerId(p))
      );
    }

    if (candidates.length === 0) {
      const exactKey = `${vk.normalized_name}|${vk.team_upper}|${vk.position_upper}`;
      const exact = (nameTeamPosIndex.get(exactKey) ?? []).filter(
        (p) => !matchedCatalogIds.has(getPlayerId(p))
      );
      if (exact.length > 0) {
        candidates = exact;
      }
    }

    if (candidates.length === 0) {
      const loose: LeanPlayer[] = [];
      for (const p of catalog) {
        if (matchedCatalogIds.has(getPlayerId(p))) continue;
        const ck = keysFromLean(p);
        if (ck.normalized_name !== vk.normalized_name) continue;
        if (ck.team_upper !== vk.team_upper && ck.team_upper !== "--" && vk.team_upper !== "--") {
          continue;
        }
        if (!positionCompatible(p.position, v.position)) continue;
        loose.push(p);
      }
      candidates = loose;
    }

    if (candidates.length === 1) {
      const p = candidates[0]!;
      const pid = getPlayerId(p);
      matchedCatalogIds.add(pid);
      matches.push({ kind: "matched", vendor: v, catalog_player_id: pid, mlb_id: p.mlbId });
      proposed_updates.push({
        mlb_id: p.mlbId,
        player_id: pid,
        set: {
          market_adp: v.adp,
          market_adp_source: sourceName,
          market_adp_updated_at: fetchedAt,
          ...(v.adp_min != null ? { market_adp_min: v.adp_min } : {}),
          ...(v.adp_max != null ? { market_adp_max: v.adp_max } : {}),
          ...(v.sample_size != null ? { market_pick_count: v.sample_size } : {}),
        },
      });
    } else if (candidates.length > 1) {
      matches.push({
        kind: "ambiguous",
        vendor: v,
        candidate_player_ids: candidates.map((x) => getPlayerId(x)),
      });
    } else {
      matches.push({
        kind: "unmatched_vendor",
        vendor: v,
        reason: "no_unique_catalog_row_for_mlb_id_or_name_team_position",
      });
    }
  }

  return { matches, proposed_updates };
}
