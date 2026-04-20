export type ExplainSeverity = "low" | "medium" | "high" | "critical";

export function severityFromUrgency(urgencyScore: number): ExplainSeverity {
  if (urgencyScore >= 90) return "critical";
  if (urgencyScore >= 75) return "high";
  if (urgencyScore >= 50) return "medium";
  return "low";
}

export function recommendedActionForSeverity(
  severity: ExplainSeverity,
  position: string
): string {
  if (severity === "critical") return `Prioritize ${position} in your next 1-2 turns.`;
  if (severity === "high") return `Move ${position} up your queue now.`;
  if (severity === "medium") return `Keep ${position} on deck if value appears.`;
  return `No urgency at ${position}; stay value-driven.`;
}

export function confidenceFromSeverity(
  severity: ExplainSeverity,
  monopolyWarnings: number
): number {
  const base =
    severity === "critical"
      ? 0.9
      : severity === "high"
        ? 0.82
        : severity === "medium"
          ? 0.74
          : 0.68;
  const caveatPenalty = monopolyWarnings > 0 ? 0.04 : 0;
  return Math.max(0.5, Math.min(0.98, Number((base - caveatPenalty).toFixed(2))));
}
