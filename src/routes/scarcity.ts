import { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import Player from "../models/Player";
import { ENGINE_CONTRACT_VERSION } from "../lib/engineContract";
import {
  recommendedActionForSeverity,
  severityFromUrgency,
} from "../lib/explainabilityScoring";
import { analyzeScarcity } from "../services/scarcityEngine";
import { cacheMiddleware } from "../middleware/cache";
import {
  draftedPlayerInputSchema,
  leagueScopeSchema,
  scoringCategorySchema,
} from "../lib/draftedPlayerZod";
import { zodIssuesToFieldErrors } from "../lib/zodErrors";
import { PLAYER_CATALOG_LEAN_SELECT } from "../lib/playerCatalogProjection";
import { LeanPlayer } from "../types/brain";

const router: Router = Router();

const scarcityBodySchema = z.object({
  drafted_players: z.array(draftedPlayerInputSchema),
  scoring_categories: z.array(scoringCategorySchema).default([]),
  position: z.string().optional(),
  num_teams: z.number().int().positive().optional(),
  league_scope: leagueScopeSchema.optional(),
});

/**
 * POST /analysis/scarcity
 *
 * Analyzes how many Elite and Mid-Tier players remain at each position given
 * the current draft state.  Also triggers Monopoly Detection warnings when a
 * single team controls a disproportionate share of a scoring category.
 */
const scarcity: RequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const parsed = scarcityBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ errors: zodIssuesToFieldErrors(parsed.error.issues) });
    return;
  }

  const input = parsed.data;
  const numTeams = input.num_teams ?? 12;

  const players = (await Player.find({})
    .select(PLAYER_CATALOG_LEAN_SELECT)
    .lean()) as unknown as LeanPlayer[];

  const result = analyzeScarcity(
    players,
    input.drafted_players,
    numTeams,
    input.scoring_categories,
    input.league_scope ?? "Mixed",
    input.position
  );

  const selected = input.position
    ? result.positions.find(
        (p) => p.position.toUpperCase() === input.position!.toUpperCase()
      ) ?? result.positions[0]
    : null;
  const selectedSeverity = selected
    ? severityFromUrgency(selected.scarcity_score)
    : "low";
  const selectedExplainer = selected
    ? {
        severity: selectedSeverity,
        urgency_score: selected.scarcity_score,
        message:
          selected.alert ??
          `${selected.position} supply is stable at this draft point.`,
        recommended_action: recommendedActionForSeverity(
          selectedSeverity,
          selected.position
        ),
      }
    : null;

  res.json({
    ...result,
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    schema_version: "2" as const,
    calculated_at: result.analyzed_at,
    selected_position: input.position,
    selected_position_explainer: selectedExplainer,
  });
};

function bodyHash(req: Request): string {
  return `ae:scarcity:${JSON.stringify(req.body)}`;
}

router.post("/", cacheMiddleware(120, bodyHash), scarcity);

export default router;
