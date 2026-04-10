import { Router, Request, Response, RequestHandler } from "express";
import Player from "../models/Player";
import { analyzeScarcity } from "../services/scarcityEngine";
import { cacheMiddleware } from "../middleware/cache";
import { LeanPlayer, ScarcityRequest } from "../types/brain";
import { ValidationError } from "../lib/appError";

const router: Router = Router();

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
  const body = req.body as Partial<ScarcityRequest>;

  // ── Input validation ────────────────────────────────────────────────────
  if (!Array.isArray(body.drafted_players)) {
    // res.status(400).json({ error: "drafted_players must be an array." });
    // return;
    throw new ValidationError("drafted_players must be an array.", 400, "Validation failed", { field: "drafted_players" });
  }

  const numTeams =
    typeof body.num_teams === "number" && body.num_teams > 0
      ? body.num_teams
      : 12;

  const scoringCategories = Array.isArray(body.scoring_categories)
    ? body.scoring_categories
    : [];

  const players = (await Player.find({}).lean()) as unknown as LeanPlayer[];

  const result = analyzeScarcity(
    players,
    body.drafted_players,
    numTeams,
    scoringCategories,
    body.league_scope ?? "Mixed",
    body.position
  );

  res.json(result);
};

function bodyHash(req: Request): string {
  return `ae:scarcity:${JSON.stringify(req.body)}`;
}

router.post("/", cacheMiddleware(120, bodyHash), scarcity);

export default router;
