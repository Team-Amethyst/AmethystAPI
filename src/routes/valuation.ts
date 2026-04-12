import { Router, Request, Response, RequestHandler } from "express";
import Player from "../models/Player";
import { parseValuationRequest } from "../lib/valuationRequest";
import { calculateInflation } from "../services/inflationEngine";
import { cacheMiddleware } from "../middleware/cache";
import { LeanPlayer } from "../types/brain";

const router: Router = Router();

/**
 * POST /valuation/calculate
 *
 * Accepts a draft state and league settings.  Returns every undrafted player
 * with an inflation-adjusted auction value and a Steal / Reach / Fair Value
 * indicator — no persistent state is written.
 */
export const valuationCalculateHandler: RequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const parsed = parseValuationRequest(req.body);
  if (!parsed.success) {
    res.status(400).json({ errors: parsed.errors });
    return;
  }

  const n = parsed.normalized;
  const logParts = [
    `[valuation]`,
    n.checkpoint != null ? `checkpoint=${n.checkpoint}` : null,
    `schema_version=${n.schemaVersion}`,
    n.seed != null ? `seed=${n.seed}` : null,
  ].filter(Boolean);
  console.info(logParts.join(" "));

  const players = (await Player.find({}).lean()) as unknown as LeanPlayer[];

  const result = calculateInflation(
    players,
    n.drafted_players,
    n.total_budget,
    n.num_teams,
    n.roster_slots,
    n.league_scope,
    {
      deterministic: n.deterministic,
      seed: n.seed,
      playerIdsFilter: n.player_ids,
      budgetByTeamId: n.budget_by_team_id,
    }
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

router.post(
  "/calculate",
  cacheMiddleware(120, bodyHash),
  valuationCalculateHandler
);

export default router;
