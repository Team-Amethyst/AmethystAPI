import { Router, Request, Response, RequestHandler } from "express";
import Player from "../models/Player";
import { getRequestId } from "../lib/requestContext";
import { normalizeCatalogPlayers } from "../lib/playerCatalog";
import { parseValuationRequest } from "../lib/valuationRequest";
import {
  executeValuationWorkflow,
  resolveScoringMode,
} from "../services/valuationWorkflow";

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
    `request_id=${getRequestId(res)}`,
    n.checkpoint != null ? `checkpoint=${n.checkpoint}` : null,
    `schema_version=${n.schemaVersion}`,
    `scoring_mode=${resolveScoringMode(n)}`,
    n.seed != null ? `seed=${n.seed}` : null,
  ].filter(Boolean);
  console.info(logParts.join(" "));

  const rawDocs = await Player.find({}).lean();
  const players = normalizeCatalogPlayers(rawDocs, (msg) =>
    console.warn(`[valuation] catalog: ${msg} request_id=${getRequestId(res)}`)
  );

  const outcome = executeValuationWorkflow(players, n);
  if (!outcome.ok) {
    res.status(422).json({
      errors: outcome.issues.map((message) => ({ field: "", message })),
    });
    return;
  }

  res.json(outcome.response);
};

router.post("/calculate", valuationCalculateHandler);

export default router;
