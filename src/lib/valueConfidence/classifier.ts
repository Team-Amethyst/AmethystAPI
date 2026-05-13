import type { LeanPlayer, NormalizedValuationInput } from "../../types/brain";
import type { ValuedPlayer, ValuationResponse } from "../../types/valuation";
import { listUnsupportedScoringCategories } from "../scoringCategorySupport";
import { isPlayerInDraftablePool, normalizeDraftablePoolMeta } from "../draftablePoolSemantics";
import { getPlayerId } from "../playerId";

/** Human-readable bucket for suspicious rows (audit / triage, not engine truth). */
export type ValueConfidenceClassification =
  | "expected auction economics"
  | "projection issue"
  | "sync/catalog issue"
  | "injury issue"
  | "position eligibility issue"
  | "two-way issue"
  | "unsupported category"
  | "market disagreement"
  | "formula issue"
  | "audit noise";

export type ValueConfidenceSeverity = "blocker" | "important" | "watch";

export type SuspiciousValueFinding = {
  scenario_id: string;
  rule_id: string;
  severity: ValueConfidenceSeverity;
  classification: ValueConfidenceClassification;
  player_id: string;
  name: string;
  market_adp: number | null;
  auction_rank: number | null;
  auction_value: number | null;
  team_value: number | null;
  max_bid: number | null;
  baseline_value: number | null;
  projection_summary: string;
  injury_severity_catalog: number | null;
  injury_severity_baseline: number | null;
  injury_multiplier: number | null;
  injury_component: number | null;
  replacement_key_used: string | null;
  replacement_value_used: number | null;
  surplus_basis: number | null;
  surplus_allocation_factor: number | null;
  notes?: string;
};

export type HeadlinePlayerCheck = {
  label: string;
  resolved_player_id: string | null;
  name_matched: string | null;
  auction_value: number | null;
  auction_rank: number | null;
  baseline_value: number | null;
  status: "ok" | "missing_from_pool" | "missing_from_valuations" | "watch_low_auction" | "error";
  notes?: string;
};

const OID_RE = /^[a-f0-9]{24}$/i;

export function playerIdLooksLikeMongoObjectId(id: string): boolean {
  return OID_RE.test(id);
}

function summarizeProjection(p: Record<string, unknown> | undefined): string {
  if (!p || typeof p !== "object") return "";
  try {
    const s = JSON.stringify(p);
    return s.length > 480 ? `${s.slice(0, 477)}…` : s;
  } catch {
    return "[unserializable]";
  }
}

function ruleToClassification(ruleId: string): ValueConfidenceClassification {
  if (ruleId === "market_adp50_auction_rank_gt200_cheap") return "expected auction economics";
  if (ruleId.startsWith("market_adp")) return "market disagreement";
  if (ruleId.startsWith("baseline_high")) return "formula issue";
  if (ruleId.startsWith("top_pitcher") || ruleId.startsWith("top_sp") || ruleId.startsWith("top_rp"))
    return "market disagreement";
  if (ruleId.startsWith("two_way")) return "two-way issue";
  if (ruleId.startsWith("injury")) return "injury issue";
  if (ruleId.startsWith("unsupported")) return "unsupported category";
  if (ruleId.startsWith("objectid")) return "sync/catalog issue";
  if (ruleId.startsWith("dup_mlb")) return "sync/catalog issue";
  return "audit noise";
}

function mkFinding(
  scenarioId: string,
  ruleId: string,
  severity: ValueConfidenceSeverity,
  row: ValuedPlayer,
  lp: LeanPlayer | undefined,
  extras: Partial<SuspiciousValueFinding> = {}
): SuspiciousValueFinding {
  const bc = row.baseline_components;
  const ve = row.valuation_explain;
  const proj = lp?.projection as Record<string, unknown> | undefined;
  return {
    scenario_id: scenarioId,
    rule_id: ruleId,
    severity,
    classification: ruleToClassification(ruleId),
    player_id: row.player_id,
    name: row.name,
    market_adp: row.market_adp ?? null,
    auction_rank: row.auction_rank ?? null,
    auction_value: row.auction_value ?? null,
    team_value: row.team_adjusted_value ?? null,
    max_bid: row.recommended_bid ?? null,
    baseline_value: row.baseline_value ?? null,
    projection_summary: summarizeProjection(proj),
    injury_severity_catalog: lp?.injurySeverity ?? null,
    injury_severity_baseline: bc?.injury_severity ?? null,
    injury_multiplier: bc?.injury_multiplier ?? null,
    injury_component: bc?.injury_component ?? null,
    replacement_key_used: ve?.replacement_key_used ?? row.debug_v2?.replacement_key_used ?? null,
    replacement_value_used: ve?.replacement_value_used ?? row.debug_v2?.replacement_value_used ?? null,
    surplus_basis: ve?.surplus_basis ?? row.debug_v2?.surplus_basis ?? null,
    surplus_allocation_factor: ve?.inflation_factor ?? row.inflation_factor ?? null,
    ...extras,
  };
}

export function findDuplicateMlbIds(pool: LeanPlayer[]): { mlbId: number; count: number }[] {
  const m = new Map<number, number>();
  for (const p of pool) {
    if (p.mlbId == null || !Number.isFinite(p.mlbId)) continue;
    m.set(p.mlbId, (m.get(p.mlbId) ?? 0) + 1);
  }
  return [...m.entries()].filter(([, c]) => c > 1).map(([mlbId, count]) => ({ mlbId, count }));
}

export type ClassifierContext = {
  scenarioId: string;
  input: NormalizedValuationInput;
  response: ValuationResponse;
  poolById: Map<string, LeanPlayer>;
  topSpAuction: number | null;
  /** When many picks are off the board, low remaining SP prices are expected — skip aggregate SP band. */
  draftedPickCount: number;
};

export function collectSuspiciousValueFindings(ctx: ClassifierContext): SuspiciousValueFinding[] {
  const { scenarioId, input, response, poolById, topSpAuction, draftedPickCount } = ctx;
  const rows = response.valuations;
  const out: SuspiciousValueFinding[] = [];

  const unsupported = listUnsupportedScoringCategories(input.scoring_categories);
  if (
    unsupported.length > 0 &&
    (!response.scoring_category_warnings || response.scoring_category_warnings.length === 0)
  ) {
    out.push({
      scenario_id: scenarioId,
      rule_id: "unsupported_category_missing_warning",
      severity: "important",
      classification: "unsupported category",
      player_id: "__league__",
      name: "__league__",
      market_adp: null,
      auction_rank: null,
      auction_value: null,
      team_value: null,
      max_bid: null,
      baseline_value: null,
      projection_summary: unsupported.map((u) => u.normalized).join("|"),
      injury_severity_catalog: null,
      injury_severity_baseline: null,
      injury_multiplier: null,
      injury_component: null,
      replacement_key_used: null,
      replacement_value_used: null,
      surplus_basis: null,
      surplus_allocation_factor: response.inflation_factor ?? null,
      notes: "Categories flagged unsupported but response has no scoring_category_warnings.",
    });
  }

  for (const row of rows) {
    const lp = poolById.get(row.player_id);
    const bc = row.baseline_components;
    const adp = row.market_adp;
    if (adp != null && adp <= 15 && row.auction_value <= 3) {
      out.push(
        mkFinding(scenarioId, "market_adp_top15_auction_le_3", "important", row, lp, {
          notes: `market_adp ${adp} but auction_value ${row.auction_value} (elite ADP band ≤15 pick #; ≤$3 auction)`,
        })
      );
    }
    if (
      adp != null &&
      adp <= 50 &&
      row.auction_rank > 200 &&
      row.auction_value <= 6
    ) {
      out.push(
        mkFinding(scenarioId, "market_adp50_auction_rank_gt200_cheap", "watch", row, lp, {
          notes: `market_adp ${adp}, auction_rank ${row.auction_rank}, auction_value ${row.auction_value}`,
        })
      );
    }
    if (
      draftedPickCount < 60 &&
      row.baseline_value >= 55 &&
      row.auction_value <= 1 &&
      row.market_adp != null &&
      row.market_adp <= 100
    ) {
      out.push(
        mkFinding(scenarioId, "market_adp_high_baseline_auction_le1", "important", row, lp, {
          notes: `market_adp ${row.market_adp}, baseline ${row.baseline_value}, auction ${row.auction_value}`,
        })
      );
    }

    const h = bc?.hitter_baseline_candidate;
    const p = bc?.pitcher_baseline_candidate;
    if (
      h != null &&
      p != null &&
      Number.isFinite(h) &&
      Number.isFinite(p) &&
      h > 2 &&
      p > 2 &&
      row.baseline_value + 0.25 < Math.min(h, p)
    ) {
      out.push(
        mkFinding(scenarioId, "two_way_below_both_candidates", "watch", row, lp, {
          notes: `baseline ${row.baseline_value} vs hitter_cand ${h} pitcher_cand ${p}`,
        })
      );
    }

    const sev = lp?.injurySeverity ?? 0;
    const im = bc?.injury_multiplier ?? 1;
    const ic = bc?.injury_component ?? 0;
    if (sev >= 2 && im >= 0.999 && Math.abs(ic) < 1e-3) {
      out.push(
        mkFinding(scenarioId, "injury_severity_no_baseline_impact", "watch", row, lp, {
          notes: `catalog injurySeverity ${sev}, injury_multiplier ${im}, injury_component ${ic}`,
        })
      );
    }

    if (playerIdLooksLikeMongoObjectId(row.player_id)) {
      out.push(mkFinding(scenarioId, "objectid_like_player_id", "watch", row, lp));
    }
  }

  const minPitcherBand = Math.max(6, (input.total_budget * input.num_teams) / 400);
  if (
    draftedPickCount < 50 &&
    topSpAuction != null &&
    topSpAuction < minPitcherBand
  ) {
    out.push({
      scenario_id: scenarioId,
      rule_id: "top_sp_below_band",
      severity: topSpAuction < 2 ? "blocker" : "watch",
      classification: "market disagreement",
      player_id: "__aggregate__",
      name: "__top_sp__",
      market_adp: null,
      auction_rank: null,
      auction_value: topSpAuction,
      team_value: null,
      max_bid: null,
      baseline_value: null,
      projection_summary: `band_floor≈${minPitcherBand.toFixed(1)}`,
      injury_severity_catalog: null,
      injury_severity_baseline: null,
      injury_multiplier: null,
      injury_component: null,
      replacement_key_used: null,
      replacement_value_used: null,
      surplus_basis: null,
      surplus_allocation_factor: response.inflation_factor ?? null,
      notes: "Highest SP auction_value in row set below heuristic band.",
    });
  }
  return out;
}

export function nearOneDollarDraftableSplit(
  rows: ValuedPlayer[],
  response: ValuationResponse
): { nearOneDraftable: number; nearOneOutside: number; nearOneUnknown: number } {
  const meta = normalizeDraftablePoolMeta({
    draftable_player_ids: response.draftable_player_ids,
    draftable_pool_size: response.draftable_pool_size,
  });
  let nearOneDraftable = 0;
  let nearOneOutside = 0;
  let nearOneUnknown = 0;
  for (const r of rows) {
    if (r.auction_value > 1.05) continue;
    const d = isPlayerInDraftablePool(meta, r.player_id);
    if (d === true) nearOneDraftable++;
    else if (d === false) nearOneOutside++;
    else nearOneUnknown++;
  }
  return { nearOneDraftable, nearOneOutside, nearOneUnknown };
}

export function topPitcherAuctions(rows: ValuedPlayer[]): { topSp: number | null; topRp: number | null } {
  let topSp: number | null = null;
  let topRp: number | null = null;
  for (const r of rows) {
    const pos = (r.position ?? "").toUpperCase();
    const av = r.auction_value;
    if (pos.includes("SP") && (!pos.includes("RP") || pos === "SP")) {
      if (topSp == null || av > topSp) topSp = av;
    }
    if (pos.includes("RP") || pos === "P") {
      if (topRp == null || av > topRp) topRp = av;
    }
  }
  return { topSp, topRp };
}

export type HeadlineResolveSpec = {
  label: string;
  needles: string[];
  /**
   * "all" = every needle substring must appear in the catalog name (order-free).
   * "any" = at least one needle matches.
   * Default: single-needle → "any", multi-needle → "all" (disambiguates Kirby Yates vs George Kirby, etc.).
   */
  match?: "all" | "any";
};

export const HEADLINE_PLAYER_LABELS: HeadlineResolveSpec[] = [
  { label: "Ohtani", needles: ["ohtani"] },
  { label: "Skenes", needles: ["skenes"] },
  { label: "Skubal", needles: ["skubal"] },
  { label: "Acuña", needles: ["acuña", "acuna"], match: "any" },
  { label: "Judge", needles: ["aaron", "judge"], match: "all" },
  { label: "Soto", needles: ["juan", "soto"], match: "all" },
  { label: "Witt", needles: ["bobby", "witt"], match: "all" },
  { label: "Raleigh", needles: ["cal", "raleigh"], match: "all" },
  { label: "Harper", needles: ["bryce", "harper"], match: "all" },
  { label: "Alvarez", needles: ["yordan", "alvarez"], match: "all" },
  { label: "Tatis", needles: ["fernando", "tatis"], match: "all" },
  { label: "Julio", needles: ["julio", "rodr"], match: "all" },
  { label: "Ragans", needles: ["cole", "ragans"], match: "all" },
  { label: "Kirby", needles: ["george", "kirby"], match: "all" },
  { label: "Devin Williams", needles: ["devin", "williams"], match: "all" },
  { label: "Cease", needles: ["dylan", "cease"], match: "all" },
  { label: "Strider", needles: ["spencer", "strider"], match: "all" },
];

function headlineNameMatches(normalizedName: string, spec: HeadlineResolveSpec): boolean {
  const needles = spec.needles.map((n) => n.toLowerCase());
  const match = spec.match ?? (needles.length === 1 ? "any" : "all");
  if (match === "all") return needles.every((n) => normalizedName.includes(n));
  return needles.some((n) => normalizedName.includes(n));
}

/** Picks best catalog `value` when multiple rows match (substring collisions). */
export function resolveHeadlinePlayerFromPool(
  pool: LeanPlayer[],
  spec: HeadlineResolveSpec
): { player: LeanPlayer; player_id: string } | null {
  const hits = pool.filter((p) => headlineNameMatches((p.name ?? "").toLowerCase(), spec));
  if (hits.length === 0) return null;
  hits.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const best = hits[0]!;
  return { player: best, player_id: getPlayerId(best) };
}

export function buildHeadlinePlayerChecks(
  pool: LeanPlayer[],
  valuations: ValuedPlayer[]
): HeadlinePlayerCheck[] {
  const byId = new Map(valuations.map((v) => [v.player_id, v]));
  const out: HeadlinePlayerCheck[] = [];
  for (const spec of HEADLINE_PLAYER_LABELS) {
    const { label } = spec;
    const hit = resolveHeadlinePlayerFromPool(pool, spec);
    if (!hit) {
      out.push({
        label,
        resolved_player_id: null,
        name_matched: null,
        auction_value: null,
        auction_rank: null,
        baseline_value: null,
        status: "missing_from_pool",
      });
      continue;
    }
    const row = byId.get(hit.player_id);
    if (!row) {
      out.push({
        label,
        resolved_player_id: hit.player_id,
        name_matched: hit.player.name,
        auction_value: null,
        auction_rank: null,
        baseline_value: null,
        status: "missing_from_valuations",
      });
      continue;
    }
    let status: HeadlinePlayerCheck["status"] = "ok";
    let notes: string | undefined;
    if (row.auction_value < 5 && (row.market_adp ?? 999) <= 80) {
      status = "watch_low_auction";
      notes = "Low auction_value relative to typical ADP band.";
    }
    out.push({
      label,
      resolved_player_id: hit.player_id,
      name_matched: hit.player.name,
      auction_value: row.auction_value,
      auction_rank: row.auction_rank,
      baseline_value: row.baseline_value,
      status,
      notes,
    });
  }
  return out;
}

export function summarizeFindings(findings: SuspiciousValueFinding[]): {
  blockers: SuspiciousValueFinding[];
  important: SuspiciousValueFinding[];
  watch: SuspiciousValueFinding[];
} {
  const blockers = findings.filter((f) => f.severity === "blocker");
  const important = findings.filter((f) => f.severity === "important");
  const watch = findings.filter((f) => f.severity === "watch");
  return { blockers, important, watch };
}
