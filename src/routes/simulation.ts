import { Router, Request, Response, RequestHandler } from "express";
import Player from "../models/Player";
import { simulateMockPicks } from "../services/mockPickEngine";
import { LeanPlayer, MockPickRequest } from "../types/brain";
import { ValidationError } from "../lib/appError";

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
    // res.status(400).json({ error: "pick_order must be a non-empty array of team IDs." });
    // return;
    throw new ValidationError("pick_order must be a non-empty array of team IDs.", 400, "Validation failed", { field: "pick_order" });
  }
  if (!Array.isArray(body.teams) || body.teams.length === 0) {
    // res.status(400).json({ error: "teams must be a non-empty array." });
    // return;
    throw new ValidationError("teams must be a non-empty array.", 400, "Validation failed", { field: "teams" });
  }
  if (!Array.isArray(body.roster_slots) || body.roster_slots.length === 0) {
    // res.status(400).json({ error: "roster_slots must be a non-empty array." });
    // return;
    throw new ValidationError("roster_slots must be a non-empty array.", 400, "Validation failed", { field: "roster_slots" });
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
