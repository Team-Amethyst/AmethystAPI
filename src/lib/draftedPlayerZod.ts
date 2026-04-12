import { z } from "zod";
import type { DraftedPlayer } from "../types/brain";

const rosterSlotSchema = z.object({
  position: z.string().min(1),
  count: z.number().int().positive(),
});

const scoringCategorySchema = z.object({
  name: z.string().min(1),
  type: z.enum(["batting", "pitching"]),
});

const leagueScopeSchema = z.enum(["Mixed", "AL", "NL"]);

/**
 * Parses a single drafted-player payload into {@link DraftedPlayer}.
 * `position` defaults from `positions[0]` or `roster_slot`.
 */
export const draftedPlayerInputSchema = z
  .object({
    player_id: z.string().min(1),
    name: z.string(),
    position: z.string().optional(),
    positions: z.array(z.string()).optional(),
    team: z.string(),
    team_id: z.string(),
    paid: z.number().optional(),
    adp: z.number().optional(),
    pick_number: z.number().optional(),
    is_keeper: z.boolean().optional(),
    keeper_cost: z.number().optional(),
    roster_slot: z.string().optional(),
  })
  .transform((val): DraftedPlayer => {
    const position =
      val.position ?? val.positions?.[0] ?? val.roster_slot ?? "";
    const out: DraftedPlayer = {
      player_id: val.player_id,
      name: val.name,
      position,
      team: val.team,
      team_id: val.team_id,
    };
    if (val.positions !== undefined) out.positions = val.positions;
    if (val.paid !== undefined) out.paid = val.paid;
    if (val.adp !== undefined) out.adp = val.adp;
    if (val.pick_number !== undefined) out.pick_number = val.pick_number;
    if (val.is_keeper !== undefined) out.is_keeper = val.is_keeper;
    if (val.keeper_cost !== undefined) out.keeper_cost = val.keeper_cost;
    if (val.roster_slot !== undefined) out.roster_slot = val.roster_slot;
    return out;
  })
  .refine((d) => d.position.length > 0, {
    message: "Each drafted player needs position, positions[], or roster_slot",
    path: ["position"],
  });

export { rosterSlotSchema, scoringCategorySchema, leagueScopeSchema };
