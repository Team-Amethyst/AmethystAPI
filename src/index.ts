import { env } from "./config/env";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import fs from "fs";
import mongoose from "mongoose";
import path from "path";
import { requestIdMiddleware } from "./middleware/requestId";

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
import { mountLicensedEngineRoutes } from "./http/mountLicensedEngines";
import { catalogRateLimiter, valuationRateLimiter } from "./middleware/engineRateLimit";

// Global error handler
import { NotFoundError } from "./lib/appError";
import errorHandler from "./middleware/errorHandler";

// Redis (eager connect so it's ready before first request)
import { getRedisClient } from "./lib/redis";
import { logger } from "./lib/logger";
import { getReadiness, readinessHttpStatus } from "./lib/readiness";
import { relaxApiKeysCollectionValidation } from "./lib/apiKeyCollection";
import { getValuationModelVersion } from "./lib/valuationModelVersion";

if (!env.mongoUri) {
  logger.fatal("Missing required environment variable: MONGO_URI");
  process.exit(1);
}

const app = express();

if (env.trustProxyFirstHop) {
  app.set("trust proxy", 1);
}

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      const allowed = env.corsAllowedOrigins;
      if (allowed.length === 0) {
        callback(null, true);
        return;
      }
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(requestIdMiddleware);

const portalPublicDir = path.join(__dirname, "../public");
let cachedPortalIndexHtml: string | null = null;

function loadPortalIndexHtml(): string {
  if (cachedPortalIndexHtml == null) {
    cachedPortalIndexHtml = fs.readFileSync(path.join(portalPublicDir, "index.html"), "utf8");
  }
  return cachedPortalIndexHtml;
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const PORTAL_API_BASE_PLACEHOLDER = "<!-- AMETHYST_API_BASE_META -->";

function portalIndexHtmlBody(): string {
  let html = loadPortalIndexHtml();
  const base = env.portalApiBaseUrl;
  const metaTag = base ? `  <meta name="amethyst-api-base" content="${escapeHtmlAttr(base)}" />\n` : "";
  if (html.includes(PORTAL_API_BASE_PLACEHOLDER)) {
    html = html.replace(PORTAL_API_BASE_PLACEHOLDER, metaTag);
  } else if (base) {
    html = html.replace("<head>", `<head>\n  <meta name="amethyst-api-base" content="${escapeHtmlAttr(base)}" />`);
  }
  return html;
}

app.get(["/", "/index.html"], (_req, res) => {
  res.type("html");
  res.send(portalIndexHtmlBody());
});

// Serve developer portal assets from public/
app.use(express.static(portalPublicDir));

// ── Public routes ─────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "Amethyst Engine",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    valuation_build_label: getValuationModelVersion(),
    git_sha: env.gitSha,
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
// Mount order: optional IP allowlist → API key → scope → tier-aware rate limit → handler.
mountLicensedEngineRoutes(app, [
  {
    legacyPath: "/valuation",
    v1Path: "/v1/valuation",
    scope: "valuation",
    rateLimiter: valuationRateLimiter,
    router: valuationRoutes,
  },
  {
    legacyPath: "/catalog",
    v1Path: "/v1/catalog",
    scope: "catalog",
    rateLimiter: catalogRateLimiter,
    router: catalogRoutes,
  },
  {
    legacyPath: "/analysis/scarcity",
    v1Path: "/v1/analysis/scarcity",
    scope: "scarcity",
    router: scarcityRoutes,
  },
  {
    legacyPath: "/simulation",
    v1Path: "/v1/simulation",
    scope: "simulation",
    router: simulationRoutes,
  },
  {
    legacyPath: "/signals",
    v1Path: "/v1/signals",
    scope: "signals",
    router: signalsRoutes,
  },
]);

// ── Global error handler ──────────────────────────────────────────────────────
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new NotFoundError("Route not found", 404, "ROUTE_NOT_FOUND"));
});

app.use(errorHandler);

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = env.port;

const mongoConnectOptions: mongoose.ConnectOptions = {
  appName: env.mongoAppName,
};
if (env.mongoMaxPoolSize != null) {
  mongoConnectOptions.maxPoolSize = env.mongoMaxPoolSize;
}

mongoose
  .connect(env.mongoUri, mongoConnectOptions)
  .then(async () => {
    logger.info("MongoDB connected");
    await relaxApiKeysCollectionValidation();
    getRedisClient().connect().catch(() => {});
    app.listen(PORT, () =>
      logger.info({ port: PORT }, "Amethyst Engine listening")
    );
  })
  .catch((err) => {
    logger.fatal({ err }, "MongoDB connection error");
    process.exit(1);
  });
