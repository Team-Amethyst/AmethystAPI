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

// Licensing middleware
import apiKeyMiddleware from "./middleware/apiKey";

// Global error handler
import { NotFoundError } from "./lib/appError";
import errorHandler from "./middleware/errorHandler";

// Redis (eager connect so it's ready before first request)
import { getRedisClient } from "./lib/redis";

dotenv.config();

// ── Environment validation ────────────────────────────────────────────────────
if (!process.env.MONGO_URI) {
  console.error("Missing required environment variable: MONGO_URI");
  process.exit(1);
}

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";

app.use(
  cors({
    origin: corsOrigin,
  }),
);

app.use(express.json());

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
  });
});

app.use("/api/usage", usageRoutes);

// ── Amethyst Engine — licensed analytical endpoints (require x-api-key) ────────
//
// All routes below are gated by the API key middleware.
// Usage is tracked per-key to support the 5% net-revenue royalty model.
app.use("/valuation", apiKeyMiddleware, valuationRoutes);
app.use("/analysis/scarcity", apiKeyMiddleware, scarcityRoutes);
app.use("/simulation", apiKeyMiddleware, simulationRoutes);
app.use("/signals", apiKeyMiddleware, signalsRoutes);

// ── Global error handler ──────────────────────────────────────────────────────
// 404 for unknown routes
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new NotFoundError("Route not found", 404,"ROUTE_NOT_FOUND"));
});

// Global typed error handler
app.use(errorHandler);

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

mongoose
  .connect(process.env.MONGO_URI as string)
  .then(() => {
    console.log("[MongoDB] Connected");
    // Eagerly connect to Redis — errors are non-fatal
    getRedisClient().connect().catch(() => {});
    app.listen(PORT, () =>
      console.log(`[Amethyst Engine] Running on http://localhost:${PORT}`)
    );
  })
  .catch((err) => {
    console.error("[MongoDB] Connection error:", err);
    process.exit(1);
  });
