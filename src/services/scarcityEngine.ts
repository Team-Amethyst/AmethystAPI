import { filterByScope } from "../lib/leagueScope";
import { getPlayerId } from "../lib/playerId";
import {
  DraftedPlayer,
  LeanPlayer,
  LeagueScope,
  ScoringCategory,
  ScarcityResponse,
} from "../types/brain";
import {
  MULTI_SLOT_POSITIONS,
  SINGLE_SLOT_POSITIONS,
} from "./scarcityConfig";
import { buildMonopolyWarnings, buildPositionScarcity } from "./scarcityHelpers";

/**
 * Analyzes positional scarcity and detects category monopolies.
 *
 * Scarcity thresholds:
 *   elite     = tier 1
 *   mid-tier  = tier 2–3
 *   depth     = tier ≥ 4
 */
export function analyzeScarcity(
  allPlayers: LeanPlayer[],
  draftedPlayers: DraftedPlayer[],
  numTeams: number,
  scoringCategories: ScoringCategory[],
  leagueScope: LeagueScope = "Mixed",
  filterPosition?: string
): ScarcityResponse {
  const draftedIds = new Set(draftedPlayers.map((d) => d.player_id));
  const scoped = filterByScope(allPlayers, leagueScope);
  const undrafted = scoped.filter((p) => !draftedIds.has(getPlayerId(p)));

  // ── Positional scarcity ───────────────────────────────────────────────────
  const allPositions = filterPosition
    ? [filterPosition]
    : [
        ...Array.from(SINGLE_SLOT_POSITIONS),
        ...Object.keys(MULTI_SLOT_POSITIONS),
      ];

  const { positions, tier_buckets } = buildPositionScarcity({
    undrafted,
    allPositions,
    numTeams,
  });

  // ── Monopoly detection ────────────────────────────────────────────────────
  const monopoly_warnings = buildMonopolyWarnings({
    draftedPlayers,
    scoped,
    scoringCategories,
  });

  return {
    positions,
    tier_buckets,
    monopoly_warnings,
    analyzed_at: new Date().toISOString(),
  };
}
