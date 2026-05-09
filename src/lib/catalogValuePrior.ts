import type { LeanPlayer } from "../types/brain";

/**
 * Mongo / catalog "list" dollars before request-specific baseline math.
 * This is a weak prior only — not the official auction output.
 */
export function catalogValuePrior(p: Pick<LeanPlayer, "value">): number {
  const v = p.value;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
