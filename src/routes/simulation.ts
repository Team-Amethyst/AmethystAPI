import { Router, Request, Response, RequestHandler } from "express";
import Player from "../models/Player";
import { simulateMockPicks } from "../services/mockPickEngine";
import { LeanPlayer, MockPickRequest } from "../types/brain";

const router: Router = Router();

/**
 * POST /simulation/mock-pick
 *
 * Given the current draft state, predicts the most likely next pick for each
 * team in the pick_order using an ADP + team-need heuristic.  Supports the
 * AI Practice Draft Environment.
 */
const mockPick: RequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const body = req.body as Partial<MockPickRequest>;

  // ── Input validation ────────────────────────────────────────────────────
  if (!Array.isArray(body.pick_order) || body.pick_order.length === 0) {
    res.status(400).json({ error: "pick_order must be a non-empty array of team IDs." });
    return;
  }
  if (!Array.isArray(body.teams) || body.teams.length === 0) {
    res.status(400).json({ error: "teams must be a non-empty array." });
    return;
  }
  if (!Array.isArray(body.roster_slots) || body.roster_slots.length === 0) {
    res.status(400).json({ error: "roster_slots must be a non-empty array." });
    return;
  }

  const players = (await Player.find({}).lean()) as unknown as LeanPlayer[];

  const result = simulateMockPicks(
    players,
    body.teams,
    body.pick_order,
    body.roster_slots,
    body.available_player_ids,
    body.league_scope
  );

  res.json(result);
};

router.post("/mock-pick", mockPick);

export default router;
