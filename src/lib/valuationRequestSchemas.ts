import { z } from "zod";
import {
  draftedPlayerInputSchema,
  leagueScopeSchema,
  rosterSlotSchema,
  scoringCategorySchema,
} from "./draftedPlayerZod";

export const budgetByTeamSchema = z.record(z.string(), z.number().nonnegative());
export const scoringFormatSchema = z.enum(["5x5", "6x6", "points"]);
export const inflationModelSchema = z.enum([
  "global_v1",
  "surplus_slots_v1",
  "replacement_slots_v2",
]);

export const teamBucketSchema = z.object({
  team_id: z.string(),
  players: z.array(draftedPlayerInputSchema),
});

export const preDraftRostersInputSchema = z.union([
  z.record(z.string(), z.array(z.unknown())),
  z.array(teamBucketSchema),
]);

export const minorsTaxiNestedUnion = z.union([
  z.array(teamBucketSchema),
  z.record(z.string(), z.array(z.unknown())),
]);

export const rosterSlotsNestedUnion = z.union([
  z.array(rosterSlotSchema).min(1),
  z
    .record(z.string(), z.number().int().positive())
    .transform((rec) =>
      Object.entries(rec).map(([position, count]) => ({ position, count }))
    ),
]);

export const leagueBlockSchema = z.object({
  id: z.string().optional(),
  roster_slots: rosterSlotsNestedUnion,
  scoring_categories: z.array(scoringCategorySchema).min(1),
  total_budget: z.number().positive(),
  num_teams: z.number().int().positive().optional(),
  league_scope: leagueScopeSchema.optional(),
  scoring_format: scoringFormatSchema.optional(),
  hitter_budget_pct: z.number().optional(),
  pos_eligibility_threshold: z.number().optional(),
  inflation_model: inflationModelSchema.optional(),
});

export const nestedValuationBodySchema = z.object({
  schemaVersion: z.string().optional(),
  schema_version: z.string().optional(),
  league_id: z.string().optional(),
  checkpoint: z.string().optional(),
  league: leagueBlockSchema,
  draft_state: z.array(draftedPlayerInputSchema),
  pre_draft_rosters: preDraftRostersInputSchema.optional(),
  minors: minorsTaxiNestedUnion.optional(),
  taxi: minorsTaxiNestedUnion.optional(),
  deterministic: z.boolean().optional(),
  seed: z.number().finite().optional(),
  player_ids: z.array(z.string().min(1)).optional(),
  budget_by_team_id: budgetByTeamSchema.optional(),
  user_team_id: z.string().min(1).optional(),
  inflation_model: inflationModelSchema.optional(),
});

export const flatValuationBodySchema = z.object({
  roster_slots: z.array(rosterSlotSchema).min(1),
  scoring_categories: z.array(scoringCategorySchema).min(1),
  total_budget: z.number().positive(),
  num_teams: z.number().int().positive().optional(),
  league_scope: leagueScopeSchema.optional(),
  drafted_players: z.array(draftedPlayerInputSchema),
  schemaVersion: z.string().optional(),
  schema_version: z.string().optional(),
  league_id: z.string().optional(),
  checkpoint: z.string().optional(),
  budget_by_team_id: budgetByTeamSchema.optional(),
  user_team_id: z.string().min(1).optional(),
  scoring_format: scoringFormatSchema.optional(),
  hitter_budget_pct: z.number().optional(),
  pos_eligibility_threshold: z.number().optional(),
  minors: z.array(teamBucketSchema).optional(),
  taxi: z.array(teamBucketSchema).optional(),
  deterministic: z.boolean().optional(),
  seed: z.number().finite().optional(),
  player_ids: z.array(z.string().min(1)).optional(),
  pre_draft_rosters: preDraftRostersInputSchema.optional(),
  inflation_model: inflationModelSchema.optional(),
});

export type NestedValuationBody = z.infer<typeof nestedValuationBodySchema>;
export type FlatValuationBody = z.infer<typeof flatValuationBodySchema>;
export type PreDraftRostersInput = z.infer<typeof preDraftRostersInputSchema>;
