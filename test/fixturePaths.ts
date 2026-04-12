import { existsSync } from "fs";
import path from "path";

/**
 * Prefer AmethystDraft’s repo-relative fixture when developing with both repos
 * checked out as siblings (`…/dev/AmethystDraft` + `…/dev/AmethystAPI`); otherwise
 * use this package’s mirrored `test-fixtures/`.
 */
export function resolveDraftOrLocalCheckpoint(fileName: string): string {
  const draftRelative = path.resolve(
    __dirname,
    "../../AmethystDraft/apps/api/test-fixtures/player-api/checkpoints",
    fileName
  );
  const local = path.join(
    __dirname,
    "../test-fixtures/player-api/checkpoints",
    fileName
  );
  return existsSync(draftRelative) ? draftRelative : local;
}
