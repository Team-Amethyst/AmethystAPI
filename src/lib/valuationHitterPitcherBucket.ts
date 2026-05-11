import type { LeanPlayer, ValuedPlayer } from "../types/brain";
import type { PositionOverrideMap } from "./fantasyPositioning";
import { isPitcherForBaseline } from "../services/baselineProjectionStats";

/**
 * Hitter vs pitcher bucket for **auction-dollar attribution** on a valuation row.
 * Matches regression harness behavior: honor `two_way_role_selected` when set, else catalog eligibility.
 */
export function valuationHitterPitcherBucket(
  row: Pick<ValuedPlayer, "position" | "baseline_components">,
  lp: LeanPlayer | undefined,
  ov: PositionOverrideMap | undefined
): "hitter" | "pitcher" {
  const sel = row.baseline_components?.two_way_role_selected;
  if (sel === "hitter" || sel === "pitcher") return sel;
  if (lp) return isPitcherForBaseline(lp, ov) ? "pitcher" : "hitter";
  const pos = (row.position ?? "").toUpperCase();
  if (pos.includes("SP") || pos.includes("RP") || pos === "P") return "pitcher";
  return "hitter";
}
