import { existsSync } from "fs";
import path from "path";

/**
 * Prefer this repo’s `test-fixtures/` (canonical for Activity #9 / 2026 draft).
 * If missing, fall back to a sibling AmethystDraft checkout when developing both repos.
 */
export function resolveDraftOrLocalCheckpoint(fileName: string): string {
  const local = path.join(
    __dirname,
    "../test-fixtures/player-api/checkpoints",
    fileName
  );
  if (existsSync(local)) return local;
  return path.resolve(
    __dirname,
    "../../AmethystDraft/apps/api/test-fixtures/player-api/checkpoints",
    fileName
  );
}
