import {
  normalizePlayerName,
  canonicalMlbTeamAbbrevForMatch,
} from "../catalogIdentityHelpers";
import type {
  DryRunMatch,
  MarketAdpMatchConfidence,
  MarketAdpVendorRow,
  ProposedCatalogUpdate,
} from "./types";
import type { LeanPlayer } from "../../types/brain";
import { getPlayerId } from "../playerId";

type CatalogMatchKey = {
  mlb_id: number | null | undefined;
  normalized_name: string;
  team_upper: string;
  position_upper: string;
  player_id: string;
};

export type MarketAdpDryRunStats = {
  vendor_rows: number;
  matched_vendor_rows: number;
  unmatched_vendor_rows: number;
  ambiguous_vendor_rows: number;
  catalog_players: number;
  matched_catalog_players: number;
  /** Catalog rows with ≥1 NFBC vendor row sharing normalized name (valid ADP). */
  catalog_players_with_nfbc_name: number;
  /** matched_catalog_players / catalog_players */
  catalog_coverage_vs_catalog: string;
  /** matched_catalog_players / catalog_players_with_nfbc_name (primary quality metric). */
  catalog_coverage_vs_nfbc_named: string;
};

export type MarketAdpCatalogAuditRow = {
  catalog_player_id: string;
  catalog_name: string;
  catalog_normalized_name: string;
  catalog_team: string;
  catalog_positions: string[];
  best_nfbc_name: string | null;
  best_nfbc_team: string | null;
  best_nfbc_positions: string | null;
  best_nfbc_adp: number | null;
  match_status: "matched" | "unmatched";
  failure_reason: string | null;
  match_confidence: MarketAdpMatchConfidence | null;
};

/** Every catalog player that did not receive a vendor match (sorted by `catalog_rank`). */
export type MarketAdpCatalogUnmatchedRow = {
  catalog_player_id: string;
  catalog_name: string;
  catalog_normalized_name: string;
  catalog_team: string;
  catalog_position: string;
  catalog_positions: string[];
  catalog_rank: number;
  auction_rank: number | null;
  best_nfbc_name: string | null;
  best_nfbc_team: string | null;
  best_nfbc_position: string | null;
  best_nfbc_adp: number | null;
  reason_not_matched: string;
  /** Weak audit hint only — not used for matching. */
  nearest_nfbc_edit_distance: number | null;
  nearest_nfbc_name: string | null;
  nearest_nfbc_team: string | null;
  nearest_nfbc_position: string | null;
  nearest_nfbc_adp: number | null;
};

export type MarketAdpUnmatchedVendorClass =
  | "absent_from_catalog"
  | "team_mismatch_only"
  | "position_mismatch_only"
  | "name_mismatch_only"
  | "unsafe_multiple_candidates"
  | "mlb_id_identity_conflict"
  | "parser_issue";

export type MarketAdpUnmatchedVendorAuditRow = {
  nfbc_name: string;
  nfbc_normalized_name: string;
  nfbc_team: string;
  nfbc_position: string;
  nfbc_adp: number;
  nfbc_mlb_id: number | null;
  classification: MarketAdpUnmatchedVendorClass;
  classification_detail: string;
};

export type MarketAdpDryRunResult = {
  matches: DryRunMatch[];
  proposed_updates: ProposedCatalogUpdate[];
  stats: MarketAdpDryRunStats;
  /** Counts of matched rows by confidence (excludes ambiguous/unmatched vendor tallies in matched keys). */
  confidence_breakdown: Record<string, number>;
  catalog_audit_top_200: MarketAdpCatalogAuditRow[];
  catalog_unmatched_report: MarketAdpCatalogUnmatchedRow[];
  unmatched_vendor_top_by_adp: MarketAdpUnmatchedVendorAuditRow[];
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

function tokenIsOutfield(t: string): boolean {
  const x = normPos(t);
  return x === "OF" || x === "LF" || x === "CF" || x === "RF";
}

function tokenIsDesignatedHitter(t: string): boolean {
  return normPos(t) === "DH";
}

/** 1B–SS plus generic IF/MI — used when sources disagree on multi-pos eligibility. */
function tokenIsInfield(t: string): boolean {
  const x = normPos(t);
  return x === "1B" || x === "2B" || x === "3B" || x === "SS" || x === "MI" || x === "IF";
}

/** Exported for tests / debug — true when a single catalog slot is compatible with vendor eligibility text. */
export function positionCompatible(catalogPos: string, vendorPos: string): boolean {
  const c = normPos(catalogPos);
  const v = normPos(vendorPos);
  if (c === v) return true;
  if (v === "P" && (c === "SP" || c === "RP")) return true;
  if (c === "P" && (v === "SP" || v === "RP")) return true;
  if (v === "DH" && c === "UTIL") return false;
  const cParts = splitPosTokens(catalogPos);
  const vParts = splitPosTokens(vendorPos);

  const cOut = cParts.some(tokenIsOutfield) || tokenIsOutfield(c);
  const vOut = vParts.some(tokenIsOutfield) || tokenIsOutfield(v);
  if (cOut && vOut) return true;

  const cHasInfield = cParts.some(tokenIsInfield) || tokenIsInfield(c);
  const vHasInfield = vParts.some(tokenIsInfield) || tokenIsInfield(v);
  if (cHasInfield && vHasInfield) return true;

  const cHasDH = cParts.some(tokenIsDesignatedHitter) || tokenIsDesignatedHitter(c);
  const vHasDH = vParts.some(tokenIsDesignatedHitter) || tokenIsDesignatedHitter(v);
  if ((cHasDH && vOut) || (vHasDH && cOut)) return true;
  if ((cHasDH && vHasInfield) || (vHasDH && cHasInfield)) return true;

  const vendorUtility = vParts.some((t) => t === "UT" || t === "UTIL");
  if (
    vendorUtility &&
    (c === "DH" || c === "UTIL" || cParts.some((t) => t === "UT" || t === "UTIL"))
  ) {
    return true;
  }
  if (vParts.some((t) => cParts.includes(t))) return true;
  return false;
}

/** Primary `position` plus optional `positions[]` (catalog eligibility). */
export function catalogEligiblePositionsCompatible(p: LeanPlayer, vendorPos: string): boolean {
  const slots = [p.position, ...(p.positions ?? [])].filter(
    (s): s is string => typeof s === "string" && s.trim() !== ""
  );
  for (const slot of slots) {
    if (positionCompatible(slot, vendorPos)) return true;
  }
  return false;
}

function keysFromLean(p: LeanPlayer): CatalogMatchKey {
  return {
    mlb_id: p.mlbId,
    normalized_name: normalizePlayerName(p.name),
    team_upper: canonicalMlbTeamAbbrevForMatch(p.team),
    position_upper: normPos(p.position),
    player_id: getPlayerId(p),
  };
}

function keysFromVendor(v: MarketAdpVendorRow): Omit<CatalogMatchKey, "player_id"> {
  return {
    mlb_id: v.mlb_id,
    normalized_name: normalizePlayerName(v.name),
    team_upper: canonicalMlbTeamAbbrevForMatch(v.team),
    position_upper: normPos(v.position),
  };
}

function catalogPositionList(p: LeanPlayer): string[] {
  const slots = [p.position, ...(p.positions ?? [])].filter(
    (s): s is string => typeof s === "string" && s.trim() !== ""
  );
  const out: string[] = [];
  for (const s of slots) {
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function readOptionalAuctionRank(p: LeanPlayer): number | null {
  const row = p as { auction_rank?: unknown };
  if (typeof row.auction_rank === "number" && Number.isFinite(row.auction_rank)) {
    return row.auction_rank;
  }
  const pr = p.projection?.auction_rank;
  if (typeof pr === "number" && Number.isFinite(pr)) return pr;
  return null;
}

/** Levenshtein distance for short name strings (audit hints only). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n]!;
}

function nearestVendorNameHint(
  catalogNorm: string,
  vendorRows: MarketAdpVendorRow[]
): {
  vendor: MarketAdpVendorRow;
  distance: number;
} | null {
  let best: { vendor: MarketAdpVendorRow; distance: number } | null = null;
  for (const v of vendorRows) {
    if (!Number.isFinite(v.adp) || v.adp <= 0) continue;
    const vn = normalizePlayerName(v.name);
    if (vn === catalogNorm) continue;
    const d = levenshtein(catalogNorm, vn);
    if (d > 3) continue;
    if (
      !best ||
      d < best.distance ||
      (d === best.distance && v.adp < best.vendor.adp)
    ) {
      best = { vendor: v, distance: d };
    }
  }
  return best;
}

function classifyUnmatchedVendor(
  v: MarketAdpVendorRow,
  catalogMlbIdSet: Set<number>,
  vendorsByNormName: Map<string, MarketAdpVendorRow[]>,
  catalogByNormName: Map<string, LeanPlayer[]>,
  matchedCatalogIds: Set<string>
): { classification: MarketAdpUnmatchedVendorClass; detail: string } {
  const nn = normalizePlayerName(v.name);
  if (!nn.trim()) {
    return { classification: "parser_issue", detail: "empty_normalized_vendor_name" };
  }

  const cList = catalogByNormName.get(nn) ?? [];
  const vList = vendorsByNormName.get(nn) ?? [];
  const vk = keysFromVendor(v);

  if (cList.length === 0) {
    const mid =
      vk.mlb_id != null && Number.isFinite(vk.mlb_id) && vk.mlb_id > 0
        ? Math.trunc(vk.mlb_id)
        : null;
    if (mid != null && catalogMlbIdSet.has(mid)) {
      return {
        classification: "name_mismatch_only",
        detail: "vendor_mlb_id_in_catalog_but_normalized_name_differs_from_catalog_display_name",
      };
    }
    return {
      classification: "absent_from_catalog",
      detail: "no_catalog_row_shares_normalized_name",
    };
  }

  if (cList.length > 1 || vList.length > 1) {
    return {
      classification: "unsafe_multiple_candidates",
      detail: `catalog_rows=${cList.length} vendor_rows=${vList.length}`,
    };
  }

  const p = cList[0]!;
  const pid = getPlayerId(p);

  if (
    vk.mlb_id != null &&
    Number.isFinite(vk.mlb_id) &&
    vk.mlb_id > 0 &&
    p.mlbId != null &&
    Number.isFinite(p.mlbId) &&
    p.mlbId > 0 &&
    vk.mlb_id !== p.mlbId
  ) {
    return {
      classification: "mlb_id_identity_conflict",
      detail: `vendor_mlb_id=${vk.mlb_id} catalog_mlb_id=${p.mlbId}`,
    };
  }

  if (!catalogEligiblePositionsCompatible(p, v.position)) {
    return {
      classification: "position_mismatch_only",
      detail: "single_name_row_pair_but_position_incompatible",
    };
  }

  const ct = canonicalMlbTeamAbbrevForMatch(p.team);
  const vt = canonicalMlbTeamAbbrevForMatch(v.team);
  if (ct !== vt && ct !== "--" && vt !== "--") {
    return {
      classification: "team_mismatch_only",
      detail: "expected_unique_team_mismatch_match_review_order_or_identity_guards",
    };
  }

  if (matchedCatalogIds.has(pid)) {
    return {
      classification: "parser_issue",
      detail: "catalog_player_already_matched_elsewhere_unexpected_for_single_name_pair",
    };
  }

  return {
    classification: "parser_issue",
    detail: "expected_matchable_single_name_row_pair",
  };
}

function buildCatalogUnmatchedReport(
  catalog: LeanPlayer[],
  vendorRows: MarketAdpVendorRow[],
  matches: DryRunMatch[]
): MarketAdpCatalogUnmatchedRow[] {
  const matchedByCatalogId = new Map<string, MarketAdpMatchConfidence>();
  for (const m of matches) {
    if (m.kind === "matched") {
      matchedByCatalogId.set(m.catalog_player_id, m.match_confidence);
    }
  }

  const unmatched = catalog.filter((p) => !matchedByCatalogId.has(getPlayerId(p)));
  unmatched.sort((a, b) => (a.catalog_rank ?? 999999) - (b.catalog_rank ?? 999999));

  return unmatched.map((p): MarketAdpCatalogUnmatchedRow => {
    const pid = getPlayerId(p);
    const nn = normalizePlayerName(p.name);
    const best = bestVendorByName(nn, vendorRows);
    const vSame = vendorRows.filter(
      (v) => normalizePlayerName(v.name) === nn && Number.isFinite(v.adp) && v.adp > 0
    );
    const cSame = catalog.filter((x) => normalizePlayerName(x.name) === nn);
    const near = nearestVendorNameHint(nn, vendorRows);
    const nearDist = near?.distance ?? null;

    let reason_not_matched: string;
    if (vSame.length === 0) {
      reason_not_matched =
        nearDist != null && nearDist <= 2
          ? `no_nfbc_row_same_normalized_name_audit_similar_vendor_name_edit_distance_${nearDist}`
          : "no_nfbc_row_same_normalized_name";
    } else if (cSame.length > 1) {
      reason_not_matched = "multiple_catalog_rows_same_normalized_name";
    } else if (vSame.length > 1) {
      reason_not_matched = "multiple_nfbc_rows_same_normalized_name";
    } else {
      const v0 = vSame[0]!;
      if (!catalogEligiblePositionsCompatible(p, v0.position)) {
        reason_not_matched = "position_incompatible_with_nfbc_row";
      } else {
        reason_not_matched = "nfbc_row_not_matched_to_this_catalog_row";
      }
    }

    return {
      catalog_player_id: pid,
      catalog_name: p.name,
      catalog_normalized_name: nn,
      catalog_team: p.team,
      catalog_position: p.position,
      catalog_positions: catalogPositionList(p),
      catalog_rank: p.catalog_rank ?? 999999,
      auction_rank: readOptionalAuctionRank(p),
      best_nfbc_name: best?.name ?? null,
      best_nfbc_team: best?.team ?? null,
      best_nfbc_position: best?.position ?? null,
      best_nfbc_adp: best?.adp ?? null,
      reason_not_matched,
      nearest_nfbc_edit_distance: nearDist,
      nearest_nfbc_name: near?.vendor.name ?? null,
      nearest_nfbc_team: near?.vendor.team ?? null,
      nearest_nfbc_position: near?.vendor.position ?? null,
      nearest_nfbc_adp: near != null ? near.vendor.adp : null,
    };
  });
}

function buildUnmatchedVendorTopByAdp(
  matches: DryRunMatch[],
  catalogMlbIdSet: Set<number>,
  vendorsByNormName: Map<string, MarketAdpVendorRow[]>,
  catalogByNormName: Map<string, LeanPlayer[]>,
  matchedCatalogIds: Set<string>,
  limit: number
): MarketAdpUnmatchedVendorAuditRow[] {
  const unmatchedVendors: MarketAdpVendorRow[] = [];
  for (const m of matches) {
    if (m.kind === "unmatched_vendor" && m.reason !== "invalid_adp") {
      unmatchedVendors.push(m.vendor);
    }
  }
  unmatchedVendors.sort((a, b) => a.adp - b.adp);
  const slice = unmatchedVendors.slice(0, limit);

  return slice.map((v): MarketAdpUnmatchedVendorAuditRow => {
    const { classification, detail } = classifyUnmatchedVendor(
      v,
      catalogMlbIdSet,
      vendorsByNormName,
      catalogByNormName,
      matchedCatalogIds
    );
    return {
      nfbc_name: v.name,
      nfbc_normalized_name: normalizePlayerName(v.name),
      nfbc_team: v.team,
      nfbc_position: v.position,
      nfbc_adp: v.adp,
      nfbc_mlb_id:
        v.mlb_id != null && Number.isFinite(v.mlb_id) && v.mlb_id > 0 ? Math.trunc(v.mlb_id) : null,
      classification,
      classification_detail: detail,
    };
  });
}

type ResolvePath =
  | "mlb_id"
  | "exact_name_team_position"
  | "exact_name_position_team_unknown"
  | "exact_name_position_team_mismatch_unique"
  | "none";

function groupVendorsByNormName(rows: MarketAdpVendorRow[]): Map<string, MarketAdpVendorRow[]> {
  const m = new Map<string, MarketAdpVendorRow[]>();
  for (const v of rows) {
    if (!Number.isFinite(v.adp) || v.adp <= 0) continue;
    const k = normalizePlayerName(v.name);
    const arr = m.get(k) ?? [];
    arr.push(v);
    m.set(k, arr);
  }
  return m;
}

function groupCatalogByNormName(rows: LeanPlayer[]): Map<string, LeanPlayer[]> {
  const m = new Map<string, LeanPlayer[]>();
  for (const p of rows) {
    const k = normalizePlayerName(p.name);
    const arr = m.get(k) ?? [];
    arr.push(p);
    m.set(k, arr);
  }
  return m;
}

function resolveCandidates(
  v: MarketAdpVendorRow,
  catalog: LeanPlayer[],
  matchedCatalogIds: Set<string>,
  byMlbId: Map<number, LeanPlayer[]>,
  nameTeamPosIndex: Map<string, LeanPlayer[]>,
  vendorsByNormName: Map<string, MarketAdpVendorRow[]>,
  catalogByNormName: Map<string, LeanPlayer[]>
): { candidates: LeanPlayer[]; path: ResolvePath } {
  const vk = keysFromVendor(v);

  if (vk.mlb_id != null && Number.isFinite(vk.mlb_id) && vk.mlb_id > 0) {
    const c = (byMlbId.get(vk.mlb_id) ?? []).filter((p) => !matchedCatalogIds.has(getPlayerId(p)));
    if (c.length > 0) return { candidates: c, path: "mlb_id" };
  }

  const exactKey = `${vk.normalized_name}|${vk.team_upper}|${vk.position_upper}`;
  const exact = (nameTeamPosIndex.get(exactKey) ?? []).filter((p) => {
    if (matchedCatalogIds.has(getPlayerId(p))) return false;
    const ck = keysFromLean(p);
    if (
      vk.mlb_id != null &&
      Number.isFinite(vk.mlb_id) &&
      vk.mlb_id > 0 &&
      ck.mlb_id != null &&
      Number.isFinite(ck.mlb_id) &&
      ck.mlb_id > 0 &&
      vk.mlb_id !== ck.mlb_id
    ) {
      return false;
    }
    return true;
  });
  if (exact.length > 0) return { candidates: exact, path: "exact_name_team_position" };

  const loose: LeanPlayer[] = [];
  for (const p of catalog) {
    if (matchedCatalogIds.has(getPlayerId(p))) continue;
    const ck = keysFromLean(p);
    if (ck.normalized_name !== vk.normalized_name) continue;
    if (
      vk.mlb_id != null &&
      Number.isFinite(vk.mlb_id) &&
      vk.mlb_id > 0 &&
      ck.mlb_id != null &&
      Number.isFinite(ck.mlb_id) &&
      ck.mlb_id > 0 &&
      vk.mlb_id !== ck.mlb_id
    ) {
      continue;
    }
    if (ck.team_upper !== vk.team_upper && ck.team_upper !== "--" && vk.team_upper !== "--") {
      continue;
    }
    if (!catalogEligiblePositionsCompatible(p, v.position)) continue;
    loose.push(p);
  }
  if (loose.length > 0) {
    const unknownTeam = loose.some((p) => {
      const ck = keysFromLean(p);
      return ck.team_upper === "--" || vk.team_upper === "--";
    });
    return {
      candidates: loose,
      path: unknownTeam ? "exact_name_position_team_unknown" : "exact_name_team_position",
    };
  }

  const vList = vendorsByNormName.get(vk.normalized_name) ?? [];
  const cList = catalogByNormName.get(vk.normalized_name) ?? [];
  if (vList.length === 1 && cList.length === 1) {
    const p = cList[0]!;
    if (matchedCatalogIds.has(getPlayerId(p))) {
      return { candidates: [], path: "none" };
    }
    if (!catalogEligiblePositionsCompatible(p, v.position)) {
      return { candidates: [], path: "none" };
    }
    if (
      v.mlb_id != null &&
      Number.isFinite(v.mlb_id) &&
      v.mlb_id > 0 &&
      p.mlbId != null &&
      Number.isFinite(p.mlbId) &&
      p.mlbId > 0 &&
      v.mlb_id !== p.mlbId
    ) {
      return { candidates: [], path: "none" };
    }
    const ct = canonicalMlbTeamAbbrevForMatch(p.team);
    const vt = canonicalMlbTeamAbbrevForMatch(v.team);
    if (ct === vt || ct === "--" || vt === "--") {
      return { candidates: [], path: "none" };
    }
    return { candidates: [p], path: "exact_name_position_team_mismatch_unique" };
  }

  return { candidates: [], path: "none" };
}

function pathToConfidence(p: ResolvePath): MarketAdpMatchConfidence | null {
  if (p === "none") return null;
  return p;
}

function bestVendorByName(
  normName: string,
  vendorRows: MarketAdpVendorRow[]
): MarketAdpVendorRow | null {
  const cands = vendorRows.filter(
    (v) => normalizePlayerName(v.name) === normName && Number.isFinite(v.adp) && v.adp > 0
  );
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.adp - b.adp);
  return cands[0]!;
}

function buildCatalogAuditTop200(
  catalog: LeanPlayer[],
  vendorRows: MarketAdpVendorRow[],
  matches: DryRunMatch[]
): MarketAdpCatalogAuditRow[] {
  const matchedByCatalogId = new Map<string, MarketAdpMatchConfidence>();
  for (const m of matches) {
    if (m.kind === "matched") {
      matchedByCatalogId.set(m.catalog_player_id, m.match_confidence);
    }
  }

  const sorted = [...catalog].sort((a, b) => (a.catalog_rank ?? 999999) - (b.catalog_rank ?? 999999));
  const top = sorted.slice(0, 200);

  return top.map((p): MarketAdpCatalogAuditRow => {
    const pid = getPlayerId(p);
    const nn = normalizePlayerName(p.name);
    const best = bestVendorByName(nn, vendorRows);
    const conf = matchedByCatalogId.get(pid) ?? null;
    const matched = conf != null;

    let failure_reason: string | null = null;
    if (!matched) {
      const vSame = vendorRows.filter(
        (v) => normalizePlayerName(v.name) === nn && Number.isFinite(v.adp) && v.adp > 0
      );
      if (vSame.length === 0) failure_reason = "no_nfbc_row_same_normalized_name";
      else {
        const cSame = catalog.filter((x) => normalizePlayerName(x.name) === nn);
        if (cSame.length > 1) failure_reason = "multiple_catalog_rows_same_name";
        else if (vSame.length > 1) failure_reason = "multiple_nfbc_rows_same_name";
        else {
          const v0 = vSame[0]!;
          if (!catalogEligiblePositionsCompatible(p, v0.position)) {
            failure_reason = "position_incompatible_with_nfbc_row";
          } else {
            failure_reason = "nfbc_row_not_matched_to_this_catalog_row";
          }
        }
      }
    }

    return {
      catalog_player_id: pid,
      catalog_name: p.name,
      catalog_normalized_name: nn,
      catalog_team: p.team,
      catalog_positions: catalogPositionList(p),
      best_nfbc_name: best?.name ?? null,
      best_nfbc_team: best?.team ?? null,
      best_nfbc_positions: best?.position ?? null,
      best_nfbc_adp: best?.adp ?? null,
      match_status: matched ? "matched" : "unmatched",
      failure_reason,
      match_confidence: conf,
    };
  });
}

function summarizeConfidence(matches: DryRunMatch[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of matches) {
    const k =
      m.kind === "matched"
        ? m.match_confidence
        : m.kind === "ambiguous"
          ? "ambiguous"
          : "unmatched";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Dry-run only: match vendor ADP rows to catalog players.
 * Prefers mlb_id, then exact name|canonical team|position, then loose name+team+position,
 * then high-confidence unique normalized name + position when NFBC and catalog each have exactly one row for that name but canonical teams disagree (stale team on one side).
 */
export function dryRunMatchMarketAdp(
  catalog: LeanPlayer[],
  vendorRows: MarketAdpVendorRow[],
  sourceName: string,
  fetchedAt: string
): MarketAdpDryRunResult {
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

  const vendorsByNormName = groupVendorsByNormName(vendorRows);
  const catalogByNormName = groupCatalogByNormName(catalog);

  const catalogMlbIdSet = new Set<number>();
  for (const p of catalog) {
    if (p.mlbId != null && Number.isFinite(p.mlbId) && p.mlbId > 0) {
      catalogMlbIdSet.add(Number(p.mlbId));
    }
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
        match_confidence: "unmatched",
      });
      continue;
    }

    const { candidates, path } = resolveCandidates(
      v,
      catalog,
      matchedCatalogIds,
      byMlbId,
      nameTeamPosIndex,
      vendorsByNormName,
      catalogByNormName
    );

    const conf = pathToConfidence(path);

    if (candidates.length === 1 && conf != null) {
      const p = candidates[0]!;
      const pid = getPlayerId(p);
      matchedCatalogIds.add(pid);
      matches.push({
        kind: "matched",
        vendor: v,
        catalog_player_id: pid,
        mlb_id: p.mlbId,
        match_confidence: conf,
      });
      proposed_updates.push({
        mlb_id: p.mlbId,
        player_id: pid,
        match_confidence: conf,
        set: {
          market_adp: v.adp,
          market_adp_source: sourceName,
          market_adp_updated_at: fetchedAt,
          market_adp_match_confidence: conf,
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
        match_confidence: "ambiguous",
      });
    } else {
      matches.push({
        kind: "unmatched_vendor",
        vendor: v,
        reason: "no_unique_catalog_row_for_mlb_id_or_name_team_position",
        match_confidence: "unmatched",
      });
    }
  }

  const matchedCatalogPlayers = matchedCatalogIds.size;
  const catalogWithNfbcName = catalog.filter((p) => {
    const nn = normalizePlayerName(p.name);
    return (vendorsByNormName.get(nn) ?? []).length > 0;
  }).length;

  const stats: MarketAdpDryRunStats = {
    vendor_rows: vendorRows.length,
    matched_vendor_rows: matches.filter((m) => m.kind === "matched").length,
    unmatched_vendor_rows: matches.filter((m) => m.kind === "unmatched_vendor").length,
    ambiguous_vendor_rows: matches.filter((m) => m.kind === "ambiguous").length,
    catalog_players: catalog.length,
    matched_catalog_players: matchedCatalogPlayers,
    catalog_players_with_nfbc_name: catalogWithNfbcName,
    catalog_coverage_vs_catalog:
      catalog.length === 0 ? "0" : ((matchedCatalogPlayers / catalog.length) * 100).toFixed(2),
    catalog_coverage_vs_nfbc_named:
      catalogWithNfbcName === 0
        ? "0"
        : ((matchedCatalogPlayers / catalogWithNfbcName) * 100).toFixed(2),
  };

  const catalog_audit_top_200 = buildCatalogAuditTop200(catalog, vendorRows, matches);
  const confidence_breakdown = summarizeConfidence(matches);
  const catalog_unmatched_report = buildCatalogUnmatchedReport(catalog, vendorRows, matches);
  const unmatched_vendor_top_by_adp = buildUnmatchedVendorTopByAdp(
    matches,
    catalogMlbIdSet,
    vendorsByNormName,
    catalogByNormName,
    matchedCatalogIds,
    60
  );

  return {
    matches,
    proposed_updates,
    stats,
    confidence_breakdown,
    catalog_audit_top_200,
    catalog_unmatched_report,
    unmatched_vendor_top_by_adp,
  };
}
