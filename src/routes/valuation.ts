import { Router, Request, Response, RequestHandler } from "express";
import Player from "../models/Player";
import { calculateInflation } from "../services/inflationEngine";
import { cacheMiddleware } from "../middleware/cache";
import { LeanPlayer, ValuationRequest } from "../types/brain";
import { ValidationError } from "../lib/appError";

const router: Router = Router();

/**
 * POST /valuation/calculate
 *
 * Accepts a draft state and league settings.  Returns every undrafted player
 * with an inflation-adjusted auction value and a Steal / Reach / Fair Value
 * indicator — no persistent state is written.
 */
const calculate: RequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const body = req.body as Partial<ValuationRequest>;

  // ── Input validation ────────────────────────────────────────────────────
  if (!Array.isArray(body.roster_slots) || body.roster_slots.length === 0) {
    // res.status(400).json({ error: "roster_slots must be a non-empty array." });
    // return;
    throw new ValidationError("roster_slots must be a non-empty array.", 400, "Validation failed", { field: "roster_slots" });
  }
  if (
    !Array.isArray(body.scoring_categories) ||
    body.scoring_categories.length === 0
  ) {
    // res
    //   .status(400)
    //   .json({ error: "scoring_categories must be a non-empty array." });
    // return;
    throw new ValidationError("scoring_categories must be a non-empty array.", 400, "Validation failed", { field: "scoring_categories" });
  }
  if (typeof body.total_budget !== "number" || body.total_budget <= 0) {
    // res
    //   .status(400)
    //   .json({ error: "total_budget must be a positive number." });
    // return;
    throw new ValidationError("total_budget must be a positive number.", 400, "Validation failed", { field: "total_budget" });
  }
  if (!Array.isArray(body.drafted_players)) {
    // res.status(400).json({ error: "drafted_players must be an array." });
    // return;
    throw new ValidationError("drafted_players must be an array.", 400, "Validation failed", { field: "drafted_players" });
  }

  const numTeams =
    typeof body.num_teams === "number" && body.num_teams > 0
      ? body.num_teams
      : 12;

  const players = (await Player.find({}).lean()) as unknown as LeanPlayer[];

  const result = calculateInflation(
    players,
    body.drafted_players,
    body.total_budget,
    numTeams,
    body.roster_slots,
    body.league_scope ?? "Mixed"
  );

  res.json(result);
};

/**
 * Cache key includes a hash of the request body so different draft states
 * get separate cache entries while identical states reuse results.
 */
function bodyHash(req: Request): string {
  return `ae:valuation:${JSON.stringify(req.body)}`;
}

router.post("/calculate", cacheMiddleware(120, bodyHash), calculate);

export default router;
