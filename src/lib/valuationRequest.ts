import type { NormalizedValuationInput } from "../types/brain";
import { zodIssuesToFieldErrors, type FieldError } from "./zodErrors";
import {
  buildNormalizedFromFlat,
  buildNormalizedFromNested,
  isNestedValuationBody,
  mergedSchemaVersion,
  normalizeFieldErrors,
} from "./valuationRequestNormalization";
import {
  flatValuationBodySchema,
  nestedValuationBodySchema,
} from "./valuationRequestSchemas";

export type { FieldError };
export type ValuationParseError = FieldError;

export type ParseValuationResult =
  | { success: true; normalized: NormalizedValuationInput }
  | { success: false; errors: FieldError[] };


/** Reject schema majors above 1 (e.g. 2.0.0). */
export function assertSupportedValuationSchemaVersion(version: string): string | null {
  const trimmed = version.trim();
  const majorStr = trimmed.split(".")[0];
  const major = parseInt(majorStr ?? "0", 10);
  if (Number.isNaN(major)) {
    return "Invalid schema_version";
  }
  if (major > 1) {
    return `Unsupported schema_version: ${trimmed} (supported majors: 0, 1)`;
  }
  return null;
}

/**
 * Rejects duplicate `player_id` in auction rows and impossible spend when not using
 * `budget_by_team_id` (sum of `paid` must not exceed `total_budget * num_teams`).
 */
export function validateDraftEconomics(
  n: NormalizedValuationInput
): FieldError | null {
  const seen = new Set<string>();
  for (const dp of n.drafted_players) {
    if (seen.has(dp.player_id)) {
      return {
        field: "drafted_players",
        message: `Duplicate player_id "${dp.player_id}"; each id must appear at most once.`,
      };
    }
    seen.add(dp.player_id);
  }

  const map = n.budget_by_team_id;
  const usesTeamBudgets = map != null && Object.keys(map).length > 0;
  if (!usesTeamBudgets) {
    const cap = n.total_budget * n.num_teams;
    const spent = n.drafted_players.reduce((s, d) => s + (d.paid ?? 0), 0);
    if (spent > cap) {
      return {
        field: "drafted_players",
        message: `Sum of paid (${spent}) exceeds total league auction dollars (${cap} = total_budget × num_teams).`,
      };
    }
  }

  return null;
}

/**
 * Validates and normalizes POST /valuation/calculate JSON:
 * - Draft upstream flat body (`drafted_players` + optional `schema_version`, …)
 * - Nested `{ league, draft_state }` (tests / legacy fixtures)
 */
export function parseValuationRequest(raw: unknown): ParseValuationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      success: false,
      errors: [{ field: "", message: "Body must be a JSON object" }],
    };
  }

  const body = raw as Record<string, unknown>;

  if (isNestedValuationBody(body)) {
    const result = nestedValuationBodySchema.safeParse(body);
    if (!result.success) {
      return {
        success: false,
        errors: normalizeFieldErrors(
          zodIssuesToFieldErrors(result.error.issues)
        ),
      };
    }
    const sv = mergedSchemaVersion(result.data, "1.0.0");
    const verErr = assertSupportedValuationSchemaVersion(sv);
    if (verErr) {
      return {
        success: false,
        errors: [{ field: "schema_version", message: verErr }],
      };
    }
    const nestedNorm = buildNormalizedFromNested(result.data);
    const eco = validateDraftEconomics(nestedNorm);
    if (eco) {
      return { success: false, errors: [eco] };
    }
    return {
      success: true,
      normalized: nestedNorm,
    };
  }

  const result = flatValuationBodySchema.safeParse(body);
  if (!result.success) {
    return {
      success: false,
      errors: normalizeFieldErrors(
        zodIssuesToFieldErrors(result.error.issues)
      ),
    };
  }
  const sv = mergedSchemaVersion(result.data, "0.0.0");
  const verErr = assertSupportedValuationSchemaVersion(sv);
  if (verErr) {
    return {
      success: false,
      errors: [{ field: "schema_version", message: verErr }],
    };
  }
  const flatNorm = buildNormalizedFromFlat(result.data);
  const ecoFlat = validateDraftEconomics(flatNorm);
  if (ecoFlat) {
    return { success: false, errors: [ecoFlat] };
  }
  return {
    success: true,
    normalized: flatNorm,
  };
}
