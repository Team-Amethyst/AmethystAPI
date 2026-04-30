import type { NormalizedValuationInput } from "../types/brain";
import type {
  FlatValuationBody,
  NestedValuationBody,
  PreDraftRostersInput,
} from "./valuationRequestSchemas";
import type { FieldError } from "./zodErrors";

export function normalizePreDraftRostersInput(
  v: PreDraftRostersInput
): Record<string, unknown[]> {
  if (Array.isArray(v)) {
    const out: Record<string, unknown[]> = {};
    for (const b of v) {
      out[b.team_id] = b.players as unknown[];
    }
    return out;
  }
  return v;
}

export function isNestedValuationBody(body: Record<string, unknown>): boolean {
  return (
    body.league != null &&
    typeof body.league === "object" &&
    !Array.isArray(body.league) &&
    Array.isArray(body.draft_state)
  );
}

export function normalizeFieldErrors(errors: FieldError[]): FieldError[] {
  return errors.map((e) =>
    e.field === "schemaVersion" ? { ...e, field: "schema_version" } : e
  );
}

export function mergedSchemaVersion(
  v: { schemaVersion?: string; schema_version?: string },
  fallback: string
): string {
  return v.schemaVersion ?? v.schema_version ?? fallback;
}

export function buildNormalizedFromNested(
  parsed: NestedValuationBody
): NormalizedValuationInput {
  const { league, draft_state, ...rest } = parsed;
  const sv = mergedSchemaVersion(rest, "1.0.0");
  const leagueId = rest.league_id ?? league.id;
  return {
    schemaVersion: sv,
    ...(leagueId ? { league_id: leagueId } : {}),
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
    pre_draft_rosters: rest.pre_draft_rosters
      ? normalizePreDraftRostersInput(rest.pre_draft_rosters)
      : undefined,
    minors: rest.minors,
    taxi: rest.taxi,
    deterministic: rest.deterministic ?? false,
    seed: rest.seed,
    player_ids: rest.player_ids,
    budget_by_team_id: rest.budget_by_team_id,
    user_team_id: rest.user_team_id,
    inflation_model: rest.inflation_model ?? league.inflation_model ?? "global_v1",
  };
}

export function buildNormalizedFromFlat(
  parsed: FlatValuationBody
): NormalizedValuationInput {
  const sv = mergedSchemaVersion(parsed, "0.0.0");
  return {
    schemaVersion: sv,
    ...(parsed.league_id ? { league_id: parsed.league_id } : {}),
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
    pre_draft_rosters: parsed.pre_draft_rosters
      ? normalizePreDraftRostersInput(parsed.pre_draft_rosters)
      : undefined,
    minors: parsed.minors,
    taxi: parsed.taxi,
    deterministic: parsed.deterministic ?? false,
    seed: parsed.seed,
    player_ids: parsed.player_ids,
    budget_by_team_id: parsed.budget_by_team_id,
    user_team_id: parsed.user_team_id,
    inflation_model: parsed.inflation_model ?? "global_v1",
  };
}
