import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";

// Existing routes
import authRoutes from "./routes/auth";
import playersRoutes from "./routes/players";

// Amethyst Engine — analytical engine routes
import valuationRoutes from "./routes/valuation";
import scarcityRoutes from "./routes/scarcity";
import simulationRoutes from "./routes/simulation";
import signalsRoutes from "./routes/signals";

// Licensing middleware
import apiKeyMiddleware from "./middleware/apiKey";

// Redis (eager connect so it's ready before first request)
import { getRedisClient } from "./lib/redis";

dotenv.config();

// ── Environment validation ────────────────────────────────────────────────────
const requiredEnvVars = ["MONGO_URI", "JWT_SECRET"];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
});

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);

app.use(express.json());

// ── Public routes ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send("Amethyst Engine — Fantasy Baseball Analytical API — Online");
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "Amethyst Engine",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/players", playersRoutes);

// ── Amethyst Engine — licensed analytical endpoints (require x-api-key) ────────
//
// All routes below are gated by the API key middleware.
// Usage is tracked per-key to support the 5% net-revenue royalty model.
app.use("/valuation", apiKeyMiddleware, valuationRoutes);
app.use("/analysis/scarcity", apiKeyMiddleware, scarcityRoutes);
app.use("/simulation", apiKeyMiddleware, simulationRoutes);
app.use("/signals", apiKeyMiddleware, signalsRoutes);

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal Server Error", message: err.message });
});

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
