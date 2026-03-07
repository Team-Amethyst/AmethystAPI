import { filterByScope } from "../lib/leagueScope";
import {
  DraftedPlayer,
  LeanPlayer,
  LeagueScope,
  MonopolyWarning,
  PositionScarcity,
  ScoringCategory,
  ScarcityResponse,
} from "../types/brain";

/** Positions that have exactly one starter slot per team in a standard league */
const SINGLE_SLOT_POSITIONS = new Set(["C", "1B", "2B", "3B", "SS"]);
/** Positions where multiple starters are expected */
const MULTI_SLOT_POSITIONS: Record<string, number> = {
  OF: 3,
  SP: 5,
  RP: 2,
};

/** Monopoly threshold: one team controls ≥ this share of a category */
const MONOPOLY_THRESHOLD = 0.40;

/**
 * Returns the canonical ID used to match this player against drafted_players.
 * Prefers mlbId (string) since that's what Draftroom sends; falls back to _id.
 */
function getPlayerId(p: LeanPlayer): string {
  return p.mlbId != null ? String(p.mlbId) : String(p._id);
}

/**
 * Returns a 0–100 scarcity score for a given position.
 *
 * Score is based on remaining elite/mid-tier count relative to the expected
 * demand (num_teams × slots_per_team for that position).
 */
function calcScarcityScore(
  eliteRemaining: number,
  midTierRemaining: number,
  expectedDemand: number
): number {
  if (expectedDemand <= 0) return 0;
  const highValueRemaining = eliteRemaining + midTierRemaining;
  const ratio = highValueRemaining / expectedDemand;
  // Clamp inversely: 0 demand-filled → 100; fully stocked → 0
  return Math.min(100, Math.max(0, Math.round((1 - ratio) * 100)));
}

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

  const positions: PositionScarcity[] = allPositions.map((pos) => {
    const atPos = undrafted.filter((p) =>
      p.position.toUpperCase().includes(pos.toUpperCase())
    );

    const elite = atPos.filter((p) => (p.tier || 99) === 1).length;
    const midTier = atPos.filter(
      (p) => (p.tier || 99) >= 2 && (p.tier || 99) <= 3
    ).length;
    const depth = atPos.filter((p) => (p.tier || 99) >= 4).length;
    const total = atPos.length;

    const slotsPerTeam = SINGLE_SLOT_POSITIONS.has(pos)
      ? 1
      : (MULTI_SLOT_POSITIONS[pos] ?? 1);
    const expectedDemand = numTeams * slotsPerTeam;
    const score = calcScarcityScore(elite, midTier, expectedDemand);

    let alert: string | null = null;
    if (elite === 0) {
      alert = `⚠️ No elite ${pos} players remaining — act immediately.`;
    } else if (elite <= 2) {
      alert = `⚠️ Only ${elite} elite ${pos} remaining — critical scarcity.`;
    } else if (score >= 70) {
      alert = `${pos} is becoming scarce (score ${score}/100). Consider drafting soon.`;
    }

    return {
      position: pos,
      elite_remaining: elite,
      mid_tier_remaining: midTier,
      depth_remaining: depth,
      total_remaining: total,
      scarcity_score: score,
      alert,
    };
  });

  // ── Monopoly detection ────────────────────────────────────────────────────
  const monopoly_warnings: MonopolyWarning[] = [];

  // Build player lookup from the full player pool
  const playerMap = new Map(scoped.map((p) => [getPlayerId(p), p]));

  for (const cat of scoringCategories) {
    const catName = cat.name.toUpperCase();

    // Determine which projection field to inspect
    type StatPath = {
      section: "batting" | "pitching";
      field: string;
    };

    const catStatMap: Record<string, StatPath> = {
      SV: { section: "pitching", field: "saves" },
      K: { section: "pitching", field: "strikeouts" },
      W: { section: "pitching", field: "wins" },
      HR: { section: "batting", field: "hr" },
      SB: { section: "batting", field: "sb" },
      RBI: { section: "batting", field: "rbi" },
      R: { section: "batting", field: "runs" },
    };

    const statPath = catStatMap[catName];
    if (!statPath) continue;

    // Accumulate projected stat totals by fantasy team
    const byTeam: Record<string, { total: number; players: string[] }> = {};
    let leagueTotal = 0;

    for (const dp of draftedPlayers) {
      const player = playerMap.get(dp.player_id);
      if (!player) continue;

      const projection = player.projection as
        | Record<string, Record<string, number>>
        | undefined;
      const statValue =
        projection?.[statPath.section]?.[statPath.field] ?? 0;
      if (statValue <= 0) continue;

      leagueTotal += statValue;
      if (!byTeam[dp.team_id]) {
        byTeam[dp.team_id] = { total: 0, players: [] };
      }
      byTeam[dp.team_id].total += statValue;
      byTeam[dp.team_id].players.push(dp.name);
    }

    if (leagueTotal === 0) continue;

    for (const [teamId, data] of Object.entries(byTeam)) {
      const share = data.total / leagueTotal;
      if (share >= MONOPOLY_THRESHOLD) {
        monopoly_warnings.push({
          team_id: teamId,
          category: `${cat.name} (${statPath.section})`,
          controlled_players: data.players,
          share_percentage: parseFloat((share * 100).toFixed(1)),
          message: `⚠️ Monopoly Warning: Team "${teamId}" controls ${(share * 100).toFixed(1)}% of projected ${cat.name} — consider counterbalancing picks.`,
        });
      }
    }
  }

  return {
    positions,
    monopoly_warnings,
    analyzed_at: new Date().toISOString(),
  };
}
