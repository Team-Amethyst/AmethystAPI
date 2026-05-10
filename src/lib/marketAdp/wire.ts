import type { CatalogPlayerValueRow } from "../../types/catalog";
import type { LeanPlayer, ValuedPlayer } from "../../types/brain";

type MarketMetaCore = Partial<
  Pick<
    CatalogPlayerValueRow,
    | "market_adp"
    | "market_adp_source"
    | "market_adp_updated_at"
    | "market_adp_min"
    | "market_adp_max"
    | "market_pick_count"
  >
>;

function marketMetaFromLean(p: LeanPlayer): MarketMetaCore {
  const o: MarketMetaCore = {};
  if (p.market_adp != null && Number.isFinite(p.market_adp) && p.market_adp > 0) {
    o.market_adp = p.market_adp;
  }
  if (p.market_adp_source != null && String(p.market_adp_source).trim() !== "") {
    o.market_adp_source = String(p.market_adp_source).trim();
  }
  if (p.market_adp_updated_at != null && String(p.market_adp_updated_at).trim() !== "") {
    o.market_adp_updated_at = String(p.market_adp_updated_at).trim();
  }
  if (p.market_adp_min != null && Number.isFinite(p.market_adp_min)) {
    o.market_adp_min = p.market_adp_min;
  }
  if (p.market_adp_max != null && Number.isFinite(p.market_adp_max)) {
    o.market_adp_max = p.market_adp_max;
  }
  if (p.market_pick_count != null && Number.isFinite(p.market_pick_count)) {
    const n = Math.trunc(p.market_pick_count);
    if (n >= 0) o.market_pick_count = n;
  }
  return o;
}

/** Attach catalog market ADP metadata to a valuation row when present on the lean player. */
export function valuedPlayerMarketFieldsFromLean(p: LeanPlayer): Partial<ValuedPlayer> {
  return marketMetaFromLean(p);
}

/** Same market metadata for catalog batch API rows. */
export function catalogPlayerMarketFieldsFromLean(
  p: LeanPlayer
): Partial<CatalogPlayerValueRow> {
  return marketMetaFromLean(p);
}
