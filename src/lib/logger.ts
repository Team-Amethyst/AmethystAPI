import pino from "pino";
import { env } from "../config/env";

function resolveLogLevel(): string {
  if (env.logLevel) {
    return env.logLevel;
  }
  if (env.isVitest || env.nodeEnv === "test") {
    return "silent";
  }
  return env.nodeEnv === "production" ? "info" : "debug";
}

/**
 * JSON logs to stdout; set `LOG_LEVEL` (e.g. `debug`, `info`, `warn`, `error`, `silent`).
 * In Vitest, defaults to `silent` unless `LOG_LEVEL` is set.
 */
export const logger = pino({
  level: resolveLogLevel(),
  base: { service: "amethyst-engine" },
});
