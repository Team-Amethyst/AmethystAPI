import { z } from "zod";
import type { NormalizedValuationInput } from "../types/brain";
import {
  draftedPlayerInputSchema,
  leagueScopeSchema,
  rosterSlotSchema,
  scoringCategorySchema,
} from "./draftedPlayerZod";
import { zodIssuesToFieldErrors, type FieldError } from "./zodErrors";

export type { FieldError };
export type ValuationParseError = FieldError;

export type ParseValuationResult =
  | { success: true; normalized: NormalizedValuationInput }
  | { success: false; errors: FieldError[] };

const budgetByTeamSchema = z.record(z.string(), z.number().nonnegative());

const scoringFormatSchema = z.enum(["5x5", "6x6", "points"]);

const teamBucketSchema = z.object({
  team_id: z.string(),
  players: z.array(draftedPlayerInputSchema),
});

const minorsTaxiNestedUnion = z.union([
  z.array(teamBucketSchema),
  z.record(z.string(), z.array(z.unknown())),
]);

const leagueBlockSchema = z.object({
  roster_slots: z.array(rosterSlotSchema).min(1),
  scoring_categories: z.array(scoringCategorySchema).min(1),
  total_budget: z.number().positive(),
  num_teams: z.number().int().positive().optional(),
  league_scope: leagueScopeSchema.optional(),
  scoring_format: scoringFormatSchema.optional(),
  hitter_budget_pct: z.number().optional(),
  pos_eligibility_threshold: z.number().optional(),
});

const nestedValuationBodySchema = z.object({
  schemaVersion: z.string().optional(),
  schema_version: z.string().optional(),
  checkpoint: z.string().optional(),
  league: leagueBlockSchema,
  draft_state: z.array(draftedPlayerInputSchema),
  pre_draft_rosters: z.record(z.string(), z.array(z.unknown())).optional(),
  minors: minorsTaxiNestedUnion.optional(),
  taxi: minorsTaxiNestedUnion.optional(),
  deterministic: z.boolean().optional(),
  seed: z.number().optional(),
  player_ids: z.array(z.string().min(1)).optional(),
  budget_by_team_id: budgetByTeamSchema.optional(),
});

/** Draft merged body from `buildEngineValuationCalculateBodyFromFixture` (flat, no league wrapper). */
const flatValuationBodySchema = z.object({
  roster_slots: z.array(rosterSlotSchema).min(1),
  scoring_categories: z.array(scoringCategorySchema).min(1),
  total_budget: z.number().positive(),
  num_teams: z.number().int().positive().optional(),
  league_scope: leagueScopeSchema.optional(),
  drafted_players: z.array(draftedPlayerInputSchema),
  schemaVersion: z.string().optional(),
  schema_version: z.string().optional(),
  checkpoint: z.string().optional(),
  budget_by_team_id: budgetByTeamSchema.optional(),
  scoring_format: scoringFormatSchema.optional(),
  hitter_budget_pct: z.number().optional(),
  pos_eligibility_threshold: z.number().optional(),
  minors: z.array(teamBucketSchema).optional(),
  taxi: z.array(teamBucketSchema).optional(),
  deterministic: z.boolean().optional(),
  seed: z.number().optional(),
  player_ids: z.array(z.string().min(1)).optional(),
  pre_draft_rosters: z.record(z.string(), z.array(z.unknown())).optional(),
});

function isNestedValuationBody(body: Record<string, unknown>): boolean {
  return (
    body.league != null &&
    typeof body.league === "object" &&
    !Array.isArray(body.league) &&
    Array.isArray(body.draft_state)
  );
}

function normalizeFieldErrors(errors: FieldError[]): FieldError[] {
  return errors.map((e) =>
    e.field === "schemaVersion"
      ? { ...e, field: "schema_version" }
      : e
  );
}

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

function mergedSchemaVersion(
  v: { schemaVersion?: string; schema_version?: string },
  fallback: string
): string {
  return v.schemaVersion ?? v.schema_version ?? fallback;
}

function buildNormalizedFromNested(
  parsed: z.infer<typeof nestedValuationBodySchema>
): NormalizedValuationInput {
  const { league, draft_state, ...rest } = parsed;
  const sv = mergedSchemaVersion(rest, "1.0.0");
  return {
    schemaVersion: sv,
    checkpoint: rest.checkpoint,
    roster_slots: league.roster_slots,
    scoring_categories: league.scoring_categories,
    total_budget: league.total_budget,
    num_teams: league.num_teams ?? 12,
    league_scope: league.league_scope ?? "Mixed",
    drafted_players: draft_state,
    scoring_format: league.scoring_format,
    hitter_budget_pct: league.hitter_budget_pct,
    pos_eligibility_threshold: league.pos_eligibility_threshold,
    pre_draft_rosters: rest.pre_draft_rosters,
    minors: rest.minors,
    taxi: rest.taxi,
    deterministic: rest.deterministic ?? false,
    seed: rest.seed,
    player_ids: rest.player_ids,
    budget_by_team_id: rest.budget_by_team_id,
  };
}

function buildNormalizedFromFlat(
  parsed: z.infer<typeof flatValuationBodySchema>
): NormalizedValuationInput {
  const sv = mergedSchemaVersion(parsed, "0.0.0");
  return {
    schemaVersion: sv,
    checkpoint: parsed.checkpoint,
    roster_slots: parsed.roster_slots,
    scoring_categories: parsed.scoring_categories,
    total_budget: parsed.total_budget,
    num_teams: parsed.num_teams ?? 12,
    league_scope: parsed.league_scope ?? "Mixed",
    drafted_players: parsed.drafted_players,
    scoring_format: parsed.scoring_format,
    hitter_budget_pct: parsed.hitter_budget_pct,
    pos_eligibility_threshold: parsed.pos_eligibility_threshold,
    pre_draft_rosters: parsed.pre_draft_rosters,
    minors: parsed.minors,
    taxi: parsed.taxi,
    deterministic: parsed.deterministic ?? false,
    seed: parsed.seed,
    player_ids: parsed.player_ids,
    budget_by_team_id: parsed.budget_by_team_id,
  };
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
    return {
      success: true,
      normalized: buildNormalizedFromNested(result.data),
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
  return {
    success: true,
    normalized: buildNormalizedFromFlat(result.data),
  };
}
