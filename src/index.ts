import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";

// Amethyst Engine — analytical engine routes
import valuationRoutes from "./routes/valuation";
import scarcityRoutes from "./routes/scarcity";
import simulationRoutes from "./routes/simulation";
import signalsRoutes from "./routes/signals";
import usageRoutes from "./routes/usage";
import keyIssuanceRoutes from "./routes/keyIssuance";
import catalogRoutes from "./routes/catalog";
import apiKeysRoutes from "./routes/apiKeys";
import developersRoutes from "./routes/developers";
import portalAuthRoutes from "./routes/portalAuth";
import accountRoutes from "./routes/account";

// Licensing middleware
import apiKeyMiddleware from "./middleware/apiKey";
import { requireApiKeyScope } from "./middleware/apiKeyScope";
import {
  engineIpAllowlistEnabled,
  engineIpAllowlistMiddleware,
} from "./middleware/ipAllowlist";
import { requestIdMiddleware } from "./middleware/requestId";
import {
  catalogRateLimiter,
  valuationRateLimiter,
} from "./middleware/engineRateLimit";

// Global error handler
import { NotFoundError } from "./lib/appError";
import errorHandler from "./middleware/errorHandler";

// Redis (eager connect so it's ready before first request)
import { getRedisClient } from "./lib/redis";
import { logger } from "./lib/logger";
import { getReadiness, readinessHttpStatus } from "./lib/readiness";
import { relaxApiKeysCollectionValidation } from "./lib/apiKeyCollection";
import { getValuationModelVersion } from "./lib/valuationModelVersion";

dotenv.config();

// ── Environment validation ────────────────────────────────────────────────────
if (!process.env.MONGO_URI) {
  logger.fatal("Missing required environment variable: MONGO_URI");
  process.exit(1);
}

const app = express();

/** Trust first proxy hop when allowlist or explicit TRUST_PROXY=1 (so `req.ip` matches client behind App Runner / ALB). */
if (engineIpAllowlistEnabled() || process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";

app.use(
  cors({
    origin: corsOrigin,
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(requestIdMiddleware);

// Serve developer portal from public/
// __dirname resolves to src/ in dev (ts-node) and dist/ in prod — both point to ../public
app.use(express.static(path.join(__dirname, "../public")));

// ── Public routes ─────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "Amethyst Engine",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    valuation_build_label: getValuationModelVersion(),
    git_sha:
      process.env.GITHUB_SHA?.trim() ||
      process.env.GIT_COMMIT?.trim() ||
      process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
      null,
  });
});

app.get("/api/health/ready", async (_req, res) => {
  const body = await getReadiness();
  res.status(readinessHttpStatus(body)).json(body);
});

app.use("/api/keys", apiKeysRoutes);
app.use("/api/keys", keyIssuanceRoutes);
app.use("/api/developers", developersRoutes);
app.use("/api/usage", usageRoutes);
app.use("/api/auth", portalAuthRoutes);
app.use("/api/account", accountRoutes);

// ── Amethyst Engine — licensed analytical endpoints (require x-api-key) ────────
//
// All routes below: optional IP allowlist → API key → scope → tier-aware rate limit → handler.
// Usage is tracked per-key to support the 5% net-revenue royalty model.
const licensedBeforeHandler = [
  engineIpAllowlistMiddleware(),
  apiKeyMiddleware,
] as const;

app.use(
  "/valuation",
  ...licensedBeforeHandler,
  requireApiKeyScope("valuation"),
  valuationRateLimiter(),
  valuationRoutes
);
app.use(
  "/catalog",
  ...licensedBeforeHandler,
  requireApiKeyScope("catalog"),
  catalogRateLimiter(),
  catalogRoutes
);
app.use(
  "/analysis/scarcity",
  ...licensedBeforeHandler,
  requireApiKeyScope("scarcity"),
  scarcityRoutes
);
app.use(
  "/simulation",
  ...licensedBeforeHandler,
  requireApiKeyScope("simulation"),
  simulationRoutes
);
app.use(
  "/signals",
  ...licensedBeforeHandler,
  requireApiKeyScope("signals"),
  signalsRoutes
);

/** Versioned mounts — same handlers/middleware as unprefixed routes (see ENGINE_AGENT_BRIEF). */
app.use(
  "/v1/valuation",
  ...licensedBeforeHandler,
  requireApiKeyScope("valuation"),
  valuationRateLimiter(),
  valuationRoutes
);
app.use(
  "/v1/catalog",
  ...licensedBeforeHandler,
  requireApiKeyScope("catalog"),
  catalogRateLimiter(),
  catalogRoutes
);
app.use(
  "/v1/analysis/scarcity",
  ...licensedBeforeHandler,
  requireApiKeyScope("scarcity"),
  scarcityRoutes
);
app.use(
  "/v1/simulation",
  ...licensedBeforeHandler,
  requireApiKeyScope("simulation"),
  simulationRoutes
);
app.use(
  "/v1/signals",
  ...licensedBeforeHandler,
  requireApiKeyScope("signals"),
  signalsRoutes
);

// ── Global error handler ──────────────────────────────────────────────────────
// 404 for unknown routes
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new NotFoundError("Route not found", 404, "ROUTE_NOT_FOUND"));
});

// Global typed error handler
app.use(errorHandler);

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

mongoose
  .connect(process.env.MONGO_URI as string)
  .then(async () => {
    logger.info("MongoDB connected");
    await relaxApiKeysCollectionValidation();
    // Eagerly connect to Redis — errors are non-fatal
    getRedisClient().connect().catch(() => {});
    app.listen(PORT, () =>
      logger.info({ port: PORT }, "Amethyst Engine listening")
    );
  })
  .catch((err) => {
    logger.fatal({ err }, "MongoDB connection error");
    process.exit(1);
  });
