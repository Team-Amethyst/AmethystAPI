import { Router, Request, Response, RequestHandler } from "express";
import { fetchSignals } from "../services/newsService";
import { cacheMiddleware } from "../middleware/cache";

const router: Router = Router();

const VALID_SIGNAL_TYPES = new Set([
  "injury",
  "role_change",
  "trade",
  "demotion",
  "promotion",
]);

/**
 * GET /signals/news
 *
 * Fetches external baseball structural signals: injury updates, role changes
 * (e.g. setup man becoming a closer), trades, demotions, and promotions.
 * Results sourced from the MLB Transactions API and cached for 15 minutes.
 *
 * Query params:
 *   days          - lookback window in days (default: 7, max: 30)
 *   signal_type   - filter by type: injury | role_change | trade | demotion | promotion
 */
const getSignals: RequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawDays = parseInt(String(req.query.days ?? "7"), 10);
  const days = Math.min(Math.max(isNaN(rawDays) ? 7 : rawDays, 1), 30);

  const signalTypeRaw = req.query.signal_type;
  const signalType =
    typeof signalTypeRaw === "string" &&
    VALID_SIGNAL_TYPES.has(signalTypeRaw.toLowerCase())
      ? signalTypeRaw.toLowerCase()
      : undefined;

  const result = await fetchSignals(days, signalType);
  res.json(result);
};

function signalsKey(req: Request): string {
  const days = req.query.days ?? "7";
  const type = req.query.signal_type ?? "all";
  return `ae:signals:news:days=${days}:type=${type}`;
}

// Cache for 15 minutes — matches the TTL set inside newsService
router.get("/news", cacheMiddleware(900, signalsKey), getSignals);
/** Product alias — same handler and cache key shape as `/news`. */
router.get("/news-signals", cacheMiddleware(900, signalsKey), getSignals);

export default router;
