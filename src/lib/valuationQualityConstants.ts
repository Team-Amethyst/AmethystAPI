import type {
  DraftPhaseIndicator,
  InflationBoundedBy,
  InflationModel,
  ValueIndicator,
} from "../types/brain";

export const BOUNDED: Set<InflationBoundedBy> = new Set(["none", "cap", "floor"]);

export const INFLATION_MODELS: Set<InflationModel> = new Set([
  "global_v1",
  "surplus_slots_v1",
  "replacement_slots_v2",
]);

export const INDICATORS: Set<ValueIndicator> = new Set([
  "Steal",
  "Reach",
  "Fair Value",
]);

export const PHASES: Set<DraftPhaseIndicator> = new Set(["early", "mid", "late"]);

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
