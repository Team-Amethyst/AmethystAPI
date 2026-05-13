import type { Logger } from "pino";
import Player from "../models/Player";
import { isValuationEligibleCatalogRow } from "./catalogRowClassification";
import {
  hydratePlaceholderCatalogTeamsFromMlb,
  isPlaceholderCatalogTeam,
} from "./catalogTeamHydration";
import { normalizeCatalogPlayers } from "./playerCatalog";
import { PLAYER_CATALOG_LEAN_SELECT } from "./playerCatalogProjection";
import type { LeanPlayer } from "../types/brain";
import type { ValuationRequestDiagnostics } from "./valuationRequestTiming";
import { addTimingMs, nowMs, setCount } from "./valuationRequestTiming";

export type MongoCatalogLoadLogger = Pick<Logger, "warn" | "info">;

/**
 * When `true`, licensed HTTP routes (valuation, scarcity, simulation) may call
 * MLB Stats API during `loadMongoCatalogForEngine` for placeholder teams.
 * Default is **false** — hydration belongs in `sync-players`, not hot request paths.
 */
export function httpCatalogMlbTeamHydrationEnabled(): boolean {
  return process.env.AMETHYST_ALLOW_HTTP_MLB_TEAM_HYDRATE === "1";
}

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
  options?: { skipMlbHydration?: boolean; diagnostics?: ValuationRequestDiagnostics }
): Promise<LeanPlayer[]> {
  const diag = options?.diagnostics;
  const wall0 = performance.now();

  const tFind0 = diag ? nowMs() : performance.now();
  const rawDocs = await Player.find({}).select(PLAYER_CATALOG_LEAN_SELECT).lean();
  const tFind1 = diag ? nowMs() : performance.now();
  if (diag) {
    addTimingMs(diag, "mongo_catalog_find_ms", tFind0, tFind1);
    setCount(diag, "catalog_rows_raw", rawDocs.length);
  }

  const tNorm0 = diag ? nowMs() : performance.now();
  const normalized = normalizeCatalogPlayers(rawDocs, (msg) =>
    log?.warn({ msg }, "catalog field coerced")
  );
  const tNorm1 = diag ? nowMs() : performance.now();
  if (diag) addTimingMs(diag, "mongo_catalog_normalize_ms", tNorm0, tNorm1);

  const preCount = normalized.length;

  const tElig0 = diag ? nowMs() : performance.now();
  const valuationRows = normalized.filter((p) => isValuationEligibleCatalogRow(p));
  const tElig1 = diag ? nowMs() : performance.now();
  if (diag) addTimingMs(diag, "mongo_catalog_eligibility_filter_ms", tElig0, tElig1);

  const excluded = preCount - valuationRows.length;
  if (diag) setCount(diag, "catalog_rows_valuation_eligible", valuationRows.length);

  if (excluded > 0) {
    log?.warn(
      { excluded_invalid_catalog_rows: excluded },
      "catalog rows excluded from valuation (no mlbId and not catalogKind=custom)"
    );
  }

  const placeholderTeamRows = valuationRows.filter((p) =>
    isPlaceholderCatalogTeam(p.team)
  ).length;

  const skipHydrate =
    Boolean(options?.skipMlbHydration) ||
    process.env.AMETHYST_SKIP_MLB_TEAM_HYDRATE === "1";

  let hydrateMs = 0;
  let hydratedCount = 0;
  let outPlayers: LeanPlayer[] = valuationRows;

  if (!skipHydrate) {
    const tHydr0 = diag ? nowMs() : performance.now();
    const hydrated = await hydratePlaceholderCatalogTeamsFromMlb(valuationRows, {
      log: (m) => log?.info({ msg: m }, "catalog team hydrate"),
    });
    const tHydr1 = diag ? nowMs() : performance.now();
    if (diag) addTimingMs(diag, "mongo_catalog_hydrate_ms", tHydr0, tHydr1);
    hydrateMs = tHydr1 - tHydr0;
    hydratedCount = hydrated.hydratedCount;
    outPlayers = hydrated.players;
  } else if (diag) {
    diag.timings_ms.mongo_catalog_hydrate_ms = 0;
  }

  const mongoFindMs = tFind1 - tFind0;
  const normalizeMs = tNorm1 - tNorm0;
  const eligibilityMs = tElig1 - tElig0;

  if (log && diag) {
    log.info(
      {
        component: "MongoCatalogPipeline",
        catalog_rows_raw: rawDocs.length,
        catalog_rows_valuation_eligible: valuationRows.length,
        catalog_placeholder_team_rows: placeholderTeamRows,
        catalog_hydrated_teams: hydratedCount,
        mongo_catalog_find_ms: Math.round(mongoFindMs),
        mongo_catalog_normalize_ms: Math.round(normalizeMs),
        mongo_catalog_eligibility_filter_ms: Math.round(eligibilityMs),
        mongo_catalog_hydrate_ms: Math.round(hydrateMs),
        mongo_catalog_total_ms: Math.round(performance.now() - wall0),
        mlb_hydration_skipped: skipHydrate,
      },
      "mongo_catalog_load"
    );
  }

  return outPlayers;
}
