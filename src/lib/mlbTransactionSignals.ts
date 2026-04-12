import type { SignalSeverity, SignalType } from "../types/brain";

/**
 * Maps MLB Stats API transaction `typeCode` + description text to Engine signal types.
 * Live API shape: `GET /api/v1/transactions?sportId=1&startDate=&endDate=` → `{ transactions: [...] }`.
 */
export function classifyMlbTransaction(
  typeCode: string,
  typeDesc: string,
  description?: string
): { type: SignalType; severity: SignalSeverity } | null {
  const code = typeCode.toUpperCase();
  const desc = typeDesc.toUpperCase();
  const full = (description ?? typeDesc).toUpperCase();

  if (
    code === "IL" ||
    desc.includes("INJURED LIST") ||
    desc.includes("DISABLED LIST") ||
    full.includes("INJURED LIST") ||
    full.includes("DISABLED LIST")
  ) {
    let severity: SignalSeverity = "medium";
    const blob = `${desc} ${full}`;
    if (blob.includes("60-DAY") || blob.includes("60 DAY")) severity = "high";
    else if (blob.includes("10-DAY") || blob.includes("10 DAY")) severity = "low";
    return { type: "injury", severity };
  }

  if (
    code === "RECALL" ||
    desc.includes("RECALLED") ||
    code === "ACTIVATE" ||
    desc.includes("ACTIVATED")
  ) {
    return { type: "promotion", severity: "low" };
  }

  if (
    code === "OPTION" ||
    desc.includes("OPTIONED") ||
    code === "DESIGNATE" ||
    desc.includes("DESIGNATED FOR ASSIGNMENT")
  ) {
    return { type: "demotion", severity: "medium" };
  }

  if (code === "TRADE" || desc.includes("TRADED")) {
    return { type: "trade", severity: "medium" };
  }

  if (
    desc.includes("CLOSER") ||
    desc.includes("SETUP MAN") ||
    desc.includes("OPENER") ||
    desc.includes("ROLE CHANGE") ||
    full.includes("CLOSER") ||
    full.includes("SETUP MAN")
  ) {
    return { type: "role_change", severity: "high" };
  }

  return null;
}
