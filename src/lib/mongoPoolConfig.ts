import path from "path";
import type { ConnectOptions } from "mongoose";

/** Default for long-lived Engine HTTP processes when MONGODB_MAX_POOL_SIZE is unset. */
export const ENGINE_MONGO_DEFAULT_MAX_POOL = 10;

const DEFAULT_SCRIPT_MAX_POOL = 5;

function parsePositiveIntEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= max ? n : fallback;
}

/**
 * Tight pool for one-off `ts-node` / `tsx` scripts (driver default maxPoolSize is 100).
 * Override with MONGODB_SCRIPT_MAX_POOL_SIZE (1–100).
 */
export function scriptMongoConnectOptions(): ConnectOptions {
  const script = path.basename(process.argv[1] ?? "script");
  return {
    appName: `AmethystScript:${script}`,
    maxPoolSize: parsePositiveIntEnv("MONGODB_SCRIPT_MAX_POOL_SIZE", DEFAULT_SCRIPT_MAX_POOL, 100),
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 30_000,
  };
}

/** Long-lived Engine — conservative defaults for shared Atlas tiers. */
export function engineMongoConnectOptions(params: { appName: string; maxPoolSize: number }): ConnectOptions {
  return {
    appName: params.appName,
    maxPoolSize: params.maxPoolSize,
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 30_000,
  };
}

/** Values actually passed to the driver (for startup / ops logs). */
export function mongoPoolSettingsForLog(opts: ConnectOptions): Record<string, unknown> {
  return {
    appName: opts.appName,
    maxPoolSize: opts.maxPoolSize,
    minPoolSize: opts.minPoolSize ?? 0,
    maxIdleTimeMS: opts.maxIdleTimeMS,
    serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS,
    socketTimeoutMS:
      opts.socketTimeoutMS === undefined
        ? "unset (driver default: 0 = no idle timeout)"
        : opts.socketTimeoutMS,
    connectTimeoutMS: opts.connectTimeoutMS ?? "unset",
  };
}
