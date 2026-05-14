/**
 * Audit-only durability / playing-time posture (no projection or dollar math).
 * @see `classifyDurabilityExpectation` in `src/lib/durabilityExpectation.ts`.
 */
export type DurabilityExpectation =
  | "full_role_expected"
  | "recovery_upside"
  | "limited_role_expected"
  | "prospect_uncertain"
  | "platoon_or_part_time"
  | "unknown";

export type DurabilityExpectationReason =
  | "low projected PA"
  | "high market ADP vs model"
  | "age/prospect profile"
  | "depth chart position"
  | "active injury severity"
  | "full workload projection";
