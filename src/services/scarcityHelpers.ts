import { getPlayerId } from "../lib/playerId";
import type {
  DraftedPlayer,
  LeanPlayer,
  MonopolyWarning,
  PositionScarcity,
  ScoringCategory,
} from "../types/brain";
import {
  CATEGORY_STAT_PATHS,
  MONOPOLY_THRESHOLD,
  MULTI_SLOT_POSITIONS,
  SINGLE_SLOT_POSITIONS,
  TIER_TARGET_FACTORS,
} from "./scarcityConfig";

export function calcScarcityScore(
  eliteRemaining: number,
  midTierRemaining: number,
  expectedDemand: number
): number {
  if (expectedDemand <= 0) return 0;
  const highValueRemaining = eliteRemaining + midTierRemaining;
  const ratio = highValueRemaining / expectedDemand;
  return Math.min(100, Math.max(0, Math.round((1 - ratio) * 100)));
}

export function bucketUrgency(remaining: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - remaining / target) * 100)));
}

function tierPlayersCount(atPos: LeanPlayer[], tier: number): number {
  return atPos.filter((p) => (p.tier || 99) === tier).length;
}

export function buildPositionScarcity(params: {
  undrafted: LeanPlayer[];
  allPositions: string[];
  numTeams: number;
}): {
  positions: PositionScarcity[];
  tier_buckets: Array<{
    position: string;
    buckets: Array<{
      tier: string;
      remaining: number;
      urgency_score: number;
      message: string;
      recommended_action: string;
    }>;
  }>;
} {
  const { undrafted, allPositions, numTeams } = params;
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
      alert = `⚠️ No Tier 1 ${pos} players remaining — act immediately.`;
    } else if (elite <= 2) {
      alert = `⚠️ Only ${elite} Tier 1 ${pos} remaining — critical scarcity.`;
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

  const tier_buckets = allPositions.map((pos) => {
    const atPos = undrafted.filter((p) =>
      p.position.toUpperCase().includes(pos.toUpperCase())
    );
    const slotsPerTeam = SINGLE_SLOT_POSITIONS.has(pos)
      ? 1
      : (MULTI_SLOT_POSITIONS[pos] ?? 1);
    const expectedDemand = numTeams * slotsPerTeam;
    const buckets = [1, 2, 3, 4, 5].map((tier) => {
      const remaining = tierPlayersCount(atPos, tier);
      const target = Math.max(
        1,
        Math.round(expectedDemand * (TIER_TARGET_FACTORS[tier] ?? 0.5))
      );
      const urgency = bucketUrgency(remaining, target);
      return {
        tier: `Tier ${tier}`,
        remaining,
        urgency_score: urgency,
        message:
          remaining === 0
            ? `Tier ${tier} ${pos} is exhausted.`
            : `${remaining} Tier ${tier} ${pos} remain.`,
        recommended_action:
          urgency >= 80
            ? `Act now if you need Tier ${tier} ${pos} quality.`
            : urgency >= 60
              ? `Prepare Tier ${tier} ${pos} as a near-term target.`
              : `Tier ${tier} ${pos} supply is currently manageable.`,
      };
    });
    return { position: pos, buckets };
  });

  return { positions, tier_buckets };
}

export function buildMonopolyWarnings(params: {
  draftedPlayers: DraftedPlayer[];
  scoped: LeanPlayer[];
  scoringCategories: ScoringCategory[];
}): MonopolyWarning[] {
  const { draftedPlayers, scoped, scoringCategories } = params;
  const monopoly_warnings: MonopolyWarning[] = [];
  const playerMap = new Map(scoped.map((p) => [getPlayerId(p), p]));

  for (const cat of scoringCategories) {
    const catName = cat.name.toUpperCase();
    const statPath = CATEGORY_STAT_PATHS[catName];
    if (!statPath) continue;
    const byTeam: Record<string, { total: number; players: string[] }> = {};
    let leagueTotal = 0;
    for (const dp of draftedPlayers) {
      const player = playerMap.get(dp.player_id);
      if (!player) continue;
      const projection = player.projection as
        | Record<string, Record<string, number>>
        | undefined;
      const statValue = projection?.[statPath.section]?.[statPath.field] ?? 0;
      if (statValue <= 0) continue;
      leagueTotal += statValue;
      if (!byTeam[dp.team_id]) byTeam[dp.team_id] = { total: 0, players: [] };
      byTeam[dp.team_id].total += statValue;
      byTeam[dp.team_id].players.push(dp.name);
    }
    if (leagueTotal === 0) continue;
    for (const [teamId, data] of Object.entries(byTeam)) {
      const share = data.total / leagueTotal;
      if (share < MONOPOLY_THRESHOLD) continue;
      monopoly_warnings.push({
        team_id: teamId,
        category: `${cat.name} (${statPath.section})`,
        controlled_players: data.players,
        share_percentage: parseFloat((share * 100).toFixed(1)),
        message: `⚠️ Monopoly Warning: Team "${teamId}" controls ${(share * 100).toFixed(1)}% of projected ${cat.name} — consider counterbalancing picks.`,
      });
    }
  }
  return monopoly_warnings;
}
