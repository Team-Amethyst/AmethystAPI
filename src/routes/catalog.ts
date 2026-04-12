import { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import Player from "../models/Player";
import { ENGINE_CONTRACT_VERSION } from "../lib/engineContract";
import { filterByScope } from "../lib/leagueScope";
import { getPlayerId } from "../services/inflationEngine";
import type {
  CatalogBatchValuesResponse,
  LeanPlayer,
} from "../types/brain";
import { getRequestId } from "../lib/requestContext";
import { logger } from "../lib/logger";
import { PLAYER_CATALOG_LEAN_SELECT } from "../lib/playerCatalogProjection";
import { zodIssuesToFieldErrors } from "../lib/zodErrors";
import { cacheMiddleware } from "../middleware/cache";

const router: Router = Router();

const batchBodySchema = z.object({
  player_ids: z.array(z.string().min(1)).min(1),
  league_scope: z.enum(["Mixed", "AL", "NL"]).optional(),
  pos_eligibility_threshold: z.number().optional(),
});

/**
 * POST /catalog/batch-values
 *
 * Baseline `value` / `tier` / `adp` from Mongo for requested MLB `player_id` strings.
 * Same id rules as `/valuation/calculate`. Cached 120s per request body (Redis when available).
 */
const batchValues: RequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const parsed = batchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ errors: zodIssuesToFieldErrors(parsed.error.issues) });
    return;
  }

  logger.info(
    {
      requestId: getRequestId(res),
      route: "catalog/batch-values",
      count: parsed.data.player_ids.length,
    },
    "catalog batch request"
  );

  const { player_ids, league_scope: leagueScope } = parsed.data;

  const numericIds = [
    ...new Set(
      player_ids
        .map((id) => Number(id))
        .filter((n) => !Number.isNaN(n))
    ),
  ];

  const docs = (await Player.find({
    mlbId: { $in: numericIds },
  })
    .select(PLAYER_CATALOG_LEAN_SELECT)
    .lean()) as unknown as LeanPlayer[];

  const idSet = new Set(player_ids);
  const byId = new Map<string, LeanPlayer>();
  for (const p of docs) {
    const pid = getPlayerId(p);
    if (idSet.has(pid)) byId.set(pid, p);
  }

  const ordered: LeanPlayer[] = [];
  for (const id of player_ids) {
    const p = byId.get(id);
    if (p) ordered.push(p);
  }

  const scoped = filterByScope(ordered, leagueScope ?? "Mixed");

  const body: CatalogBatchValuesResponse = {
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    players: scoped.map((p) => ({
      player_id: getPlayerId(p),
      name: p.name,
      position: p.position,
      team: p.team,
      value: p.value ?? 0,
      tier: p.tier ?? 0,
      adp: p.adp ?? 0,
    })),
  };

  res.json(body);
};

function bodyHash(req: Request): string {
  return `ae:catalog:batch:${JSON.stringify(req.body)}`;
}

router.post("/batch-values", cacheMiddleware(120, bodyHash), batchValues);

export default router;
