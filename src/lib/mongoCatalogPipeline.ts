import type { Logger } from "pino";
import Player from "../models/Player";
import { isValuationEligibleCatalogRow } from "./catalogRowClassification";
import { normalizeCatalogPlayers } from "./playerCatalog";
import { PLAYER_CATALOG_LEAN_SELECT } from "./playerCatalogProjection";
import { hydratePlaceholderCatalogTeamsFromMlb } from "./catalogTeamHydration";
import type { LeanPlayer } from "../types/brain";

export type MongoCatalogLoadLogger = Pick<Logger, "warn" | "info">;

/**
 * Full Mongo lean load → numeric coercion → optional MLB hydration for
 * placeholder teams (`--`, FA, …) so AL/NL league_scope filters match a full catalog.
 *
 * **Offline / CI:** set `AMETHYST_SKIP_MLB_TEAM_HYDRATE=1` (or pass
 * `{ skipMlbHydration: true }`) to skip Stats API calls. That is safe for
 * unit tests and sandboxes without network; catalog math still runs.
 *
 * **AL/NL with skip:** if Mongo rows still have placeholder `team` and
 * hydration is skipped, `league_scope` AL/NL pools stay thin until operators
 * run `pnpm sync-players` (or another job that persists real abbreviations).
 *
 * **HTTP batch catalog:** `src/routes/catalog.ts` uses the same hydration helper
 * on the requested id subset (not this function) so batch-values league_scope
 * matches engine behavior.
 */
export async function loadMongoCatalogForEngine(
  log?: MongoCatalogLoadLogger,
  options?: { skipMlbHydration?: boolean }
): Promise<LeanPlayer[]> {
  const rawDocs = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean();
  const normalized = normalizeCatalogPlayers(rawDocs, (msg) =>
    log?.warn({ msg }, "catalog field coerced")
  );
  const preCount = normalized.length;
  const valuationRows = normalized.filter((p) => isValuationEligibleCatalogRow(p));
  const excluded = preCount - valuationRows.length;
  if (excluded > 0) {
    log?.warn(
      { excluded_invalid_catalog_rows: excluded },
      "catalog rows excluded from valuation (no mlbId and not catalogKind=custom)"
    );
  }
  if (
    options?.skipMlbHydration ||
    process.env.AMETHYST_SKIP_MLB_TEAM_HYDRATE === "1"
  ) {
    return valuationRows;
  }
  const { players } = await hydratePlaceholderCatalogTeamsFromMlb(
    valuationRows,
    {
      log: (m) => log?.info({ msg: m }, "catalog team hydrate"),
    }
  );
  return players;
}
