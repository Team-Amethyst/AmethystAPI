import type { CalculateInflationOptions, ValuedPlayer } from "../types/brain";

/**
 * Quintile tiers (1 = strongest) from rank within a fixed response pool.
 * Equal-population buckets so tier boundaries adapt to pool size.
 *
 * We use distribution-based tiers (not fixed dollar bands) because auction_value and
 * baseline_value scales shift with inflation model, league size, and scoring — percentiles
 * stay comparable within a single valuation response.
 */
export function distributionTierFromRank(rank: number, poolSize: number): number {
  if (poolSize <= 0 || rank < 1) return 1;
  const r = Math.min(rank, poolSize);
  for (let t = 1; t <= 5; t++) {
    const cutoff = Math.ceil((t * poolSize) / 5);
    if (r <= cutoff) return t;
  }
  return 5;
}

function hash32(seed: number, s: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i);
    h >>>= 0;
  }
  return h >>> 0;
}

export function compareValuedPlayersForRank(
  a: ValuedPlayer,
  b: ValuedPlayer,
  valueKey: "auction_value" | "baseline_value",
  options?: CalculateInflationOptions
): number {
  const va = a[valueKey];
  const vb = b[valueKey];
  const diff = vb - va;
  if (diff !== 0) return diff;
  if (options?.deterministic && options.seed != null && Number.isFinite(options.seed)) {
    return hash32(options.seed, a.player_id) - hash32(options.seed, b.player_id);
  }
  return a.player_id.localeCompare(b.player_id);
}

/** Mutates rows in place: fills auction_rank, baseline_rank, auction_tier, baseline_tier. */
export function attachAuctionBaselineRanksAndTiers(
  rows: ValuedPlayer[],
  options?: CalculateInflationOptions
): void {
  const n = rows.length;
  if (n === 0) return;

  const byAuction = [...rows].sort((a, b) =>
    compareValuedPlayersForRank(a, b, "auction_value", options)
  );
  const byBaseline = [...rows].sort((a, b) =>
    compareValuedPlayersForRank(a, b, "baseline_value", options)
  );

  const auctionRank = new Map(byAuction.map((r, i) => [r.player_id, i + 1]));
  const baselineRank = new Map(byBaseline.map((r, i) => [r.player_id, i + 1]));

  for (const r of rows) {
    const ar = auctionRank.get(r.player_id) ?? 1;
    const br = baselineRank.get(r.player_id) ?? 1;
    r.auction_rank = ar;
    r.baseline_rank = br;
    r.auction_tier = distributionTierFromRank(ar, n);
    r.baseline_tier = distributionTierFromRank(br, n);
  }
}
