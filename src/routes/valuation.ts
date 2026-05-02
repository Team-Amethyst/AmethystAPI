import { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { getRequestId } from "../lib/requestContext";
import { logger } from "../lib/logger";
import { parseValuationRequest } from "../lib/valuationRequest";
import { runValuationWithMongoCatalog } from "../services/valuationCatalogRun";
import { resolveScoringMode } from "../services/valuationWorkflow";

const router: Router = Router();
const singlePlayerSchema = z.object({
  player_id: z.string().min(1),
});

async function runValuation(
  req: Request,
  res: Response,
  overridePlayerIds?: string[],
  scope: { playerId?: string; position?: string } = {}
) {
  const parsed = parseValuationRequest(req.body);
  if (!parsed.success) {
    res.status(400).json({ errors: parsed.errors });
    return null;
  }

  const n = {
    ...parsed.normalized,
    player_ids: overridePlayerIds ?? parsed.normalized.player_ids,
  };
  const reqLog = logger.child({
    requestId: getRequestId(res),
    route: "valuation/calculate",
  });
  reqLog.info(
    {
      checkpoint: n.checkpoint ?? null,
      schema_version: n.schemaVersion,
      scoring_mode: resolveScoringMode(n),
      seed: n.seed ?? null,
      player_ids_count: n.player_ids?.length ?? 0,
    },
    "valuation request"
  );

  const outcome = await runValuationWithMongoCatalog(n, scope, reqLog);
  if (!outcome.ok) {
    res.status(422).json({
      errors: outcome.issues.map((message) => ({ field: "", message })),
    });
    return null;
  }
  if (env.valuationAggregateLog) {
    reqLog.info(
      {
        inflation_model: outcome.response.inflation_model,
        inflation_factor: outcome.response.inflation_factor,
        inflation_raw: outcome.response.inflation_raw,
        inflation_bounded_by: outcome.response.inflation_bounded_by,
        pool_value_remaining: outcome.response.pool_value_remaining,
        total_budget_remaining: outcome.response.total_budget_remaining,
        players_remaining: outcome.response.players_remaining,
        valuation_model_version: outcome.response.valuation_model_version ?? null,
      },
      "valuation_aggregate"
    );
  }
  return outcome.response;
}

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
  const response = await runValuation(req, res);
  if (!response) return;
  res.json(response);
};

/**
 * POST /valuation/player
 *
 * Same valuation contract as /valuation/calculate but scoped to one player_id.
 * Uses full draft context for inflation and indicator math.
 */
export const valuationPlayerHandler: RequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const one = singlePlayerSchema.safeParse(req.body);
  if (!one.success) {
    res.status(400).json({
      errors: [{ field: "player_id", message: "player_id is required" }],
    });
    return;
  }

  const response = await runValuation(
    req,
    res,
    [one.data.player_id],
    { playerId: one.data.player_id }
  );
  if (!response) return;
  const player = response.valuations[0];
  if (!player) {
    res.status(404).json({
      errors: [{ field: "player_id", message: "Player not found in valuation pool" }],
    });
    return;
  }
  res.json({
    ...response,
    player,
  });
};

router.post("/calculate", valuationCalculateHandler);
router.post("/player", valuationPlayerHandler);

export default router;
