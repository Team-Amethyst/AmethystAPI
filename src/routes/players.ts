import { Router, Request, Response, RequestHandler } from "express";
import Player from "../models/Player";

const router: Router = Router();

const getPlayers: RequestHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const sortBy = typeof req.query.sortBy === "string" ? req.query.sortBy : "adp";

    let sortOptions: Record<string, 1 | -1> = { adp: 1 };
    if (sortBy === "value") {
      sortOptions = { value: -1 };
    } else if (sortBy === "name") {
      sortOptions = { name: 1 };
    }

    const players = await Player.find({}).sort(sortOptions).lean();

    const normalizedPlayers = players.map((player) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, __v, ...rest } = player as Record<string, unknown>;
      return {
        ...rest,
        id: String((player as { id?: string }).id ?? _id),
      };
    });

    res.json({ players: normalizedPlayers, count: normalizedPlayers.length });
  } catch (err) {
    console.error("Get players error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

router.get("/", getPlayers);

export default router;
