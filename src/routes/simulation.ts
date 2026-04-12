import { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import Player from "../models/Player";
import { simulateMockPicks } from "../services/mockPickEngine";
import {
  draftedPlayerInputSchema,
  leagueScopeSchema,
  rosterSlotSchema,
} from "../lib/draftedPlayerZod";
import { zodIssuesToFieldErrors } from "../lib/zodErrors";
import { LeanPlayer } from "../types/brain";

const router: Router = Router();

const mockPickBodySchema = z.object({
  pick_order: z.array(z.string().min(1)).min(1),
  teams: z
    .array(
      z.object({
        team_id: z.string().min(1),
        budget_remaining: z.number().optional(),
        roster: z.array(draftedPlayerInputSchema),
      })
    )
    .min(1),
  roster_slots: z.array(rosterSlotSchema).min(1),
  available_player_ids: z.array(z.string().min(1)).optional(),
  league_scope: leagueScopeSchema.optional(),
});

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
  const parsed = mockPickBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ errors: zodIssuesToFieldErrors(parsed.error.issues) });
    return;
  }

  const body = parsed.data;

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
