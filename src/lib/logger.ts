import pino from "pino";

function resolveLogLevel(): string {
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return "silent";
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

/**
 * JSON logs to stdout; set `LOG_LEVEL` (e.g. `debug`, `info`, `warn`, `error`, `silent`).
 * In Vitest, defaults to `silent` unless `LOG_LEVEL` is set.
 */
export const logger = pino({
  level: resolveLogLevel(),
  base: { service: "amethyst-engine" },
});
