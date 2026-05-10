/**
 * Catalog row classes for Mongo `players`: MLB-canonical, explicit custom, or invalid for valuation.
 */

import { getPlayerId } from "./playerId";
import type { LeanPlayer } from "../types/brain";

export type CatalogRowClass =
  | "canonical_mlb_player"
  | "custom_player"
  | "invalid_catalog_row";

export type CatalogKind = "mlb" | "custom";

function coerceCatalogKind(raw: unknown): CatalogKind | undefined {
  if (raw === "mlb" || raw === "custom") return raw;
  return undefined;
}

function coercePositiveMlbId(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t && /^\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isSafeInteger(n) && n > 0) return n;
    }
  }
  return undefined;
}

/** Raw Mongo doc or normalized lean shape. */
export function classifyCatalogDoc(doc: Record<string, unknown>): CatalogRowClass {
  const kind = coerceCatalogKind(doc.catalogKind);
  const mlbId = coercePositiveMlbId(doc.mlbId);

  if (kind === "custom") return "custom_player";
  if (mlbId != null) return "canonical_mlb_player";
  return "invalid_catalog_row";
}

export function classifyLeanPlayer(p: LeanPlayer & { catalogKind?: CatalogKind }): CatalogRowClass {
  return classifyCatalogDoc(p as unknown as Record<string, unknown>);
}

/** Rows allowed into valuation / inflation / baseline pools. */
export function isValuationEligibleCatalogRow(p: LeanPlayer & { catalogKind?: CatalogKind }): boolean {
  const c = classifyLeanPlayer(p);
  return c === "canonical_mlb_player" || c === "custom_player";
}

export function nonCustomObjectIdValuationId(p: LeanPlayer & { catalogKind?: CatalogKind }): boolean {
  const id = getPlayerId(p);
  const oid = /^[a-f0-9]{24}$/i.test(id);
  if (!oid) return false;
  return classifyLeanPlayer(p) !== "custom_player";
}
