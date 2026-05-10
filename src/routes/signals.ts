import { Router, Request, Response, RequestHandler } from "express";
import {
  formatEtagHeader,
  ifNoneMatchIsCurrent,
  stableSignalsPayloadFingerprint,
} from "../lib/signalsHttp";
import {
  buildSignalsCacheKey,
  fetchSignals,
  signalsHttpEtagCacheKey,
} from "../services/newsService";
import { getCached } from "../lib/redis";

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
 * Conditional GET: responds with `ETag` (payload fingerprint excluding `fetched_at`).
 * Send `If-None-Match` to receive `304 Not Modified` with an empty body when unchanged.
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

  const cacheKey = buildSignalsCacheKey(days, signalType);
  const etagKey = signalsHttpEtagCacheKey(cacheKey);
  const inm = req.headers["if-none-match"];

  const cachedFingerprint = await getCached<string>(etagKey);
  if (cachedFingerprint && ifNoneMatchIsCurrent(inm, cachedFingerprint)) {
    res.setHeader("ETag", formatEtagHeader(cachedFingerprint));
    res.status(304).end();
    return;
  }

  const result = await fetchSignals(days, signalType);
  const fingerprint = stableSignalsPayloadFingerprint(
    result.signals,
    result.count
  );
  res.setHeader("ETag", formatEtagHeader(fingerprint));

  if (ifNoneMatchIsCurrent(inm, fingerprint)) {
    res.status(304).end();
    return;
  }

  res.json(result);
};

// Response caching is handled inside newsService (Redis). ETag + If-None-Match handled in handler.
router.get("/news", getSignals);
/** Product alias — same handler and `/news`. */
router.get("/news-signals", getSignals);

export default router;
